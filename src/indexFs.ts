import * as vscode from 'vscode';
import * as nodePath from 'node:path';
import * as git from './git';
import { ApplySettings, applySettings } from './enablement';
import { refreshRepository } from './gitExtension';
import { SCHEME, StageEditTarget, pathKey, parseStageEditUri, pathsEqual } from './uris';

/** Modes we are willing to write over in the working tree. Symlinks and gitlinks are not. */
const REGULAR_FILE_MODES = new Set(['100644', '100755']);

interface Served {
	/** Object id of the blob we last handed to, or wrote on behalf of, the editor. */
	objectId: string;
	/** Monotonic stamp VS Code uses to tell our own writes from outside ones. */
	mtime: number;
	size: number;
}

export type WorkingTreeOutcome =
	/** Setting says never, so the file on disk was not considered. */
	| 'not-requested'
	/** Written from the new index entry. */
	| 'synced'
	/** Left alone because it carries unstaged changes that a sync would have destroyed. */
	| 'skipped-dirty'
	/** Not a regular file in the index — a symlink or anything else we will not write over. */
	| 'skipped-unsupported';

/** Why a save was turned away without touching the index. */
export type RefusalReason =
	/** The user was asked about overwriting the file and said no. */
	| 'declined'
	/** A live apply came round while the file was dirty; the user has not been asked. */
	| 'automatic'
	/** A dialog for this file is already on screen. */
	| 'already-asking';

export type DirtyFileAnswer =
	/** Stage the edit and write the file on disk, losing its unstaged changes. */
	| 'overwrite'
	/** Stage the edit and leave the file on disk exactly as it is. */
	| 'index-only'
	/** Do nothing at all; the save fails. */
	| 'cancel';

export type ConfirmDirtyApply = (target: StageEditTarget) => Promise<DirtyFileAnswer>;

const INDEX_ONLY = 'Only Update Index';
const OVERWRITE = 'Overwrite the File';

/**
 * Modal on purpose. One of the options destroys work, and the dialog is raised from inside the
 * save, so it has to be answered rather than drifting off into the notification centre leaving
 * the save hanging.
 *
 * The non-destructive option comes first: it is both the safer default and, in practice, what
 * you usually want — you edited the staged copy, and the unstaged work in that file is
 * deliberate.
 */
async function confirmDirtyApplyModal(target: StageEditTarget): Promise<DirtyFileAnswer> {
	const name = nodePath.basename(target.relativePath);
	const choice = await vscode.window.showWarningMessage(
		`${name} has unstaged changes.`,
		{
			modal: true,
			detail:
				`Applying this staged edit also writes ${name} on disk, which would overwrite ` +
				`the unstaged changes in it.\n\n` +
				`"${INDEX_ONLY}" stages the edit and leaves the file alone. To stop being asked, ` +
				`set "stageEdit.apply.syncWorkingTree" to "whenSafe" to always keep the file, or ` +
				`"always" to always overwrite it.`,
		},
		INDEX_ONLY,
		OVERWRITE,
	);

	switch (choice) {
		case INDEX_ONLY:
			return 'index-only';
		case OVERWRITE:
			return 'overwrite';
		default:
			return 'cancel';
	}
}

function refusalMessage(target: StageEditTarget, reason: RefusalReason): string {
	const name = nodePath.basename(target.relativePath);
	switch (reason) {
		case 'declined':
			return `${name} was not staged: you cancelled. Nothing was written, not even the index.`;
		case 'automatic':
			return `${name} has unstaged changes. Save explicitly to decide what to do about them.`;
		case 'already-asking':
			return `Still waiting on an answer about ${name}.`;
	}
}

export interface IndexWriteEvent {
	target: StageEditTarget;
	objectId: string;
	workingTree: WorkingTreeOutcome;
}

/**
 * A writable filesystem view of the Git index.
 *
 * The built-in Git extension serves both sides of a staged diff from its own `git:` provider,
 * which it registers read-only — that is the whole reason staged changes cannot be edited. We
 * register the same content under `stage-edit:` and accept writes, turning them into
 * `hash-object` + `update-index`. The working tree is left alone unless
 * `stageEdit.apply.syncWorkingTree` says otherwise.
 */
export class IndexFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
	private readonly fileChangeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.fileChangeEmitter.event;

	private readonly writeEmitter = new vscode.EventEmitter<IndexWriteEvent>();
	readonly onDidWriteIndex = this.writeEmitter.event;

	private readonly served = new Map<string, Served>();
	private readonly automaticApplies = new Set<string>();
	private readonly confirming = new Set<string>();

	/**
	 * Asked what to do about a file that has unstaged changes. Injectable so the decision can
	 * be driven from a test without a modal dialog blocking the run.
	 */
	constructor(
		private readonly confirmDirtyApply: ConfirmDirtyApply = confirmDirtyApplyModal,
	) {}

	dispose(): void {
		this.fileChangeEmitter.dispose();
		this.writeEmitter.dispose();
		this.served.clear();
		this.automaticApplies.clear();
		this.confirming.clear();
	}

	watch(): vscode.Disposable {
		// Changes are detected through the Git extension's repository state instead of a
		// per-file watcher; see refreshStaleDocuments.
		return new vscode.Disposable(() => undefined);
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const target = this.requireTarget(uri);

		// Writing a file makes VS Code walk up the path to make sure the parent folders exist,
		// and every one of those probes arrives here carrying the same query. Report ancestors
		// as the directories they are, or mkdirp decides the parent is a file and refuses.
		if (!isFileUri(uri, target)) {
			if (isAncestorUri(uri, target)) {
				return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
			}
			throw vscode.FileSystemError.FileNotFound(uri);
		}

		const entry = await git.getIndexEntry(target.repositoryRoot, target.relativePath);
		if (!entry) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}

		const size = await git.getBlobSize(target.repositoryRoot, entry.objectId);
		const key = documentKey(uri);
		const previous = this.served.get(key);

		// Keep the stamp stable while the index entry is unchanged: VS Code compares it against
		// the value it saw at save time and warns about an outside edit when it moves.
		const mtime =
			previous && previous.objectId === entry.objectId ? previous.mtime : Date.now();
		this.served.set(key, { objectId: entry.objectId, mtime, size });

		return { type: vscode.FileType.File, ctime: mtime, mtime, size, permissions: undefined };
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const target = this.requireTarget(uri);
		if (!isFileUri(uri, target)) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		const entry = await git.getIndexEntry(target.repositoryRoot, target.relativePath);
		if (!entry) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		const content = await git.readBlob(target.repositoryRoot, entry.objectId);
		const key = documentKey(uri);
		this.served.set(key, {
			objectId: entry.objectId,
			mtime: this.served.get(key)?.mtime ?? Date.now(),
			size: content.byteLength,
		});
		return content;
	}

	async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
		const target = this.requireTarget(uri);
		if (!isFileUri(uri, target)) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		const entry = await git.getIndexEntry(target.repositoryRoot, target.relativePath);
		if (!entry) {
			// The path left the index while the editor was open — staged for deletion, or the
			// change was committed or unstaged behind our back.
			throw vscode.FileSystemError.FileNotFound(
				`${target.relativePath} is no longer in the Git index, so these edits have nowhere to go.`,
			);
		}

		const settings = applySettings(target);
		const automatic = this.automaticApplies.delete(documentKey(uri));

		// Decided in full *before* the index is touched. Under `askWhenDirty` the user can
		// still call the whole thing off, and a cancelled save must leave the index exactly as
		// it was — not half-applied.
		const plan = await this.planWorkingTree(uri, target, entry, settings, automatic);
		if ('refusal' in plan) {
			throw vscode.FileSystemError.NoPermissions(refusalMessage(target, plan.refusal));
		}

		const buffer = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
		const objectId = await git.writeIndexBlob(
			target.repositoryRoot,
			target.relativePath,
			entry.mode,
			buffer,
		);

		if (plan.workingTree === 'synced') {
			await git.checkoutIndexToWorkingTree(target.repositoryRoot, target.relativePath);
		}

		this.served.set(documentKey(uri), {
			objectId,
			mtime: Date.now(),
			size: buffer.byteLength,
		});

		await refreshRepository(target.repositoryRoot);
		this.writeEmitter.fire({ target, objectId, workingTree: plan.workingTree });
	}

	/**
	 * Marks the next write to `uri` as coming from the automatic live apply rather than from
	 * the user pressing save. An automatic apply never raises the overwrite dialog: a modal
	 * appearing unbidden a few hundred milliseconds after a keystroke would be awful, so it is
	 * quietly held back until the user saves on purpose and can answer for themselves.
	 */
	markAutomaticApply(uri: vscode.Uri): void {
		this.automaticApplies.add(documentKey(uri));
	}

	private async planWorkingTree(
		uri: vscode.Uri,
		target: StageEditTarget,
		entry: git.IndexEntry,
		settings: ApplySettings,
		automatic: boolean,
	): Promise<{ workingTree: WorkingTreeOutcome } | { refusal: RefusalReason }> {
		const mode = settings.syncWorkingTree;

		if (mode === 'never') {
			return { workingTree: 'not-requested' };
		}
		if (!REGULAR_FILE_MODES.has(entry.mode)) {
			// Nothing on disk we are willing to write, so nothing can be lost either, and
			// there is nothing to refuse.
			return { workingTree: 'skipped-unsupported' };
		}
		if (mode === 'always') {
			return { workingTree: 'synced' };
		}

		if (await git.isWorkingTreeFileClean(target.repositoryRoot, target.relativePath)) {
			return { workingTree: 'synced' };
		}

		if (mode === 'whenSafe') {
			return { workingTree: 'skipped-dirty' };
		}

		// askWhenDirty: the file has unstaged changes and following along would destroy them.
		if (automatic) {
			return { refusal: 'automatic' };
		}

		const key = documentKey(uri);
		if (this.confirming.has(key)) {
			return { refusal: 'already-asking' };
		}
		this.confirming.add(key);
		try {
			switch (await this.confirmDirtyApply(target)) {
				case 'overwrite':
					return { workingTree: 'synced' };
				case 'index-only':
					return { workingTree: 'skipped-dirty' };
				case 'cancel':
					return { refusal: 'declined' };
			}
		} finally {
			this.confirming.delete(key);
		}
	}

	/**
	 * Tells the editor to re-read any open staged document whose index entry changed underneath
	 * it. Dirty documents are left alone: VS Code would raise a conflict the user cannot
	 * usefully resolve, and their unsaved edits are the more valuable copy.
	 */
	async refreshStaleDocuments(): Promise<void> {
		const documents = vscode.workspace.textDocuments.filter(
			(document) => document.uri.scheme === SCHEME && !document.isDirty,
		);

		const changes: vscode.FileChangeEvent[] = [];
		for (const document of documents) {
			const target = parseStageEditUri(document.uri);
			if (!target) {
				continue;
			}
			const key = documentKey(document.uri);
			const previous = this.served.get(key);
			const entry = await git.getIndexEntry(target.repositoryRoot, target.relativePath);

			if (!entry) {
				this.served.delete(key);
				changes.push({ type: vscode.FileChangeType.Deleted, uri: document.uri });
				continue;
			}
			if (previous && previous.objectId !== entry.objectId) {
				this.served.set(key, { ...previous, objectId: entry.objectId, mtime: Date.now() });
				changes.push({ type: vscode.FileChangeType.Changed, uri: document.uri });
			}
		}

		if (changes.length > 0) {
			this.fileChangeEmitter.fire(changes);
		}
	}

	private requireTarget(uri: vscode.Uri): StageEditTarget {
		const target = parseStageEditUri(uri);
		if (!target) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		return target;
	}

	readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
		throw vscode.FileSystemError.NoPermissions(uri);
	}

	createDirectory(uri: vscode.Uri): void {
		// The directories along the path already "exist" as far as stat is concerned, so a
		// mkdirp that gets this far has nothing left to do.
		const target = this.requireTarget(uri);
		if (isAncestorUri(uri, target)) {
			return;
		}
		throw vscode.FileSystemError.NoPermissions(uri);
	}

	delete(uri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions(uri);
	}

	rename(oldUri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions(oldUri);
	}
}

/** The URI path our scheme uses for the file itself. */
function filePathOf(target: StageEditTarget): string {
	return vscode.Uri.file(`${target.repositoryRoot}/${target.relativePath}`).path;
}

/** Map key for a document, folded so a difference in case cannot split one file into two. */
function documentKey(uri: vscode.Uri): string {
	return pathKey(uri.toString());
}

function isFileUri(uri: vscode.Uri, target: StageEditTarget): boolean {
	return pathsEqual(uri.path, filePathOf(target));
}

/** True when `uri` names a directory on the way down to the file. */
function isAncestorUri(uri: vscode.Uri, target: StageEditTarget): boolean {
	const prefix = uri.path.endsWith('/') ? uri.path : `${uri.path}/`;
	return pathKey(filePathOf(target)).startsWith(pathKey(prefix));
}
