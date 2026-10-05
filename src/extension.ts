import * as vscode from 'vscode';
import * as nodePath from 'node:path';
import * as git from './git';
import { ApplySettings, Enablement, applySettings } from './enablement';
import { IndexFileSystemProvider } from './indexFs';
import { onAnyRepositoryStateChange } from './gitExtension';
import {
	StagedDiffTab,
	activeEditableTab,
	activeStagedTab,
	isTabStillOpen,
	openEditable,
	openEditableForTab,
} from './stagedDiff';
import { SCHEME, StageEditTarget, parseStageEditUri, resolveTarget, toHeadUri } from './uris';

/** Set while a read-only staged diff is focused; gates the edit button and the typing prompt. */
const CONTEXT_STAGED_DIFF_ACTIVE = 'stageEdit.stagedDiffActive';
/** Set while our editable view is focused; gates the apply/discard commands. */
const CONTEXT_EDITABLE_DIFF_ACTIVE = 'stageEdit.editableDiffActive';
/** Set while the prompt is on screen, so a flurry of keystrokes raises it only once. */
const CONTEXT_PROMPT_ACTIVE = 'stageEdit.promptActive';

export function activate(context: vscode.ExtensionContext): void {
	const enablement = new Enablement();
	const provider = new IndexFileSystemProvider();

	context.subscriptions.push(
		enablement,
		provider,
		vscode.workspace.registerFileSystemProvider(SCHEME, provider, {
			isCaseSensitive: true,
			isReadonly: false,
		}),
	);

	void setContext(CONTEXT_PROMPT_ACTIVE, false);

	registerTabTracking(context, enablement);
	registerLiveApply(context, provider);
	registerCommands(context, enablement);

	context.subscriptions.push(
		provider.onDidWriteIndex((event) => {
			// A skipped sync is worth saying out loud, quietly: the setting asked for the
			// working tree to follow along and this one time it deliberately did not.
			if (event.workingTree === 'skipped-dirty') {
				void vscode.window.setStatusBarMessage(
					`$(git-commit) Staged ${nodePath.basename(event.target.relativePath)}. Working tree left as it is — it has unstaged changes.`,
					5000,
				);
			}
		}),
	);

	void onAnyRepositoryStateChange(() => void provider.refreshStaleDocuments(), context.subscriptions);
}

export function deactivate(): void {
	// Everything is disposed through context.subscriptions.
}

// --- Tracking which kind of staged view is in front -------------------------------------

function registerTabTracking(
	context: vscode.ExtensionContext,
	enablement: Enablement,
): void {
	// Files already auto-swapped once, so a failed swap (binary, unmerged, ...) is not retried
	// on every focus change.
	const skipped = new Set<string>();

	const update = async () => {
		const staged = activeStagedTab();
		const editable = activeEditableTab();

		// Set from the URI alone, with no git call, so the keybinding context is accurate by
		// the time the user's first keystroke is dispatched.
		await setContext(CONTEXT_STAGED_DIFF_ACTIVE, staged !== undefined);
		await setContext(CONTEXT_EDITABLE_DIFF_ACTIVE, editable !== undefined);

		if (!staged) {
			return;
		}

		const target = await resolveTarget(staged.fsPath);
		if (!target || skipped.has(staged.modified.toString())) {
			return;
		}

		if (enablement.isEnabled(target) && isTabStillOpen(staged.tab)) {
			const result = await openEditableForTab(staged);
			// Only a verdict about the file itself is worth remembering. A lost race or a tab
			// that closed underneath us says nothing, and recording those would wedge the file
			// on the read-only diff for the rest of the session.
			if (result === 'unsupported' || result === 'not-a-repository') {
				skipped.add(staged.modified.toString());
			}
		}
	};

	context.subscriptions.push(
		vscode.window.tabGroups.onDidChangeTabs(() => void update()),
		vscode.window.tabGroups.onDidChangeTabGroups(() => void update()),
		vscode.window.onDidChangeActiveTextEditor(() => void update()),
		enablement.onDidChange(() => {
			skipped.clear();
			void update();
		}),
	);

	void update();
}

function setContext(key: string, value: boolean): Thenable<unknown> {
	return vscode.commands.executeCommand('setContext', key, value);
}

// --- Live apply -------------------------------------------------------------------------

/**
 * Applies a live-mode edit, holding back rather than interrupting.
 *
 * Under `askWhenDirty` a dirty working tree means the save needs an answer from the user, and
 * a modal arriving unbidden mid-keystroke is not the way to ask. The check here keeps the
 * common case quiet; the provider's own automatic-apply guard covers the case where the file
 * turns dirty in the gap between this check and the write.
 */
async function applyAutomatically(
	provider: IndexFileSystemProvider,
	document: vscode.TextDocument,
	target: StageEditTarget,
	settings: ApplySettings,
): Promise<void> {
	if (settings.syncWorkingTree === 'askWhenDirty') {
		const clean = await git
			.isWorkingTreeFileClean(target.repositoryRoot, target.relativePath)
			.catch(() => false);
		if (!clean) {
			void vscode.window.setStatusBarMessage(
				`$(circle-slash) ${nodePath.basename(target.relativePath)} has unstaged changes — save to decide.`,
				5000,
			);
			return;
		}
	}

	provider.markAutomaticApply(document.uri);
	try {
		await document.save();
	} catch {
		// A refused automatic apply is reported by the provider; the edit stays in the buffer.
	}
}

function registerLiveApply(
	context: vscode.ExtensionContext,
	provider: IndexFileSystemProvider,
): void {
	const timers = new Map<string, NodeJS.Timeout>();

	const cancel = (key: string) => {
		const timer = timers.get(key);
		if (timer) {
			clearTimeout(timer);
			timers.delete(key);
		}
	};

	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument((event) => {
			const { document } = event;
			if (document.uri.scheme !== SCHEME || event.contentChanges.length === 0) {
				return;
			}
			const target = parseStageEditUri(document.uri);
			if (!target) {
				return;
			}
			const settings = applySettings(target);
			if (settings.mode !== 'live') {
				return;
			}

			// Saving is the single write path: it routes through the filesystem provider, so
			// live mode and manual saves cannot drift apart.
			const key = document.uri.toString();
			cancel(key);
			timers.set(
				key,
				setTimeout(() => {
					timers.delete(key);
					if (document.isDirty && !document.isClosed) {
						void applyAutomatically(provider, document, target, settings);
					}
				}, settings.liveDebounce),
			);
		}),
		vscode.workspace.onDidCloseTextDocument((document) => cancel(document.uri.toString())),
		new vscode.Disposable(() => {
			timers.forEach((timer) => clearTimeout(timer));
			timers.clear();
		}),
	);
}

// --- Commands ---------------------------------------------------------------------------

function registerCommands(context: vscode.ExtensionContext, enablement: Enablement): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'stageEdit.openEditable',
			(argument?: { resourceUri?: vscode.Uri }) => openEditableCommand(argument),
		),
		vscode.commands.registerCommand('stageEdit.promptEnable', () =>
			promptEnableCommand(enablement),
		),
		vscode.commands.registerCommand('stageEdit.alwaysForThisFile', () =>
			alwaysForThisFileCommand(enablement),
		),
		vscode.commands.registerCommand('stageEdit.applyNow', async () => {
			const document = activeStageEditDocument();
			if (!document) {
				void vscode.window.showInformationMessage('No editable staged file is focused.');
				return;
			}
			await document.save();
		}),
		vscode.commands.registerCommand('stageEdit.revertToIndex', async () => {
			if (!activeStageEditDocument()) {
				void vscode.window.showInformationMessage('No editable staged file is focused.');
				return;
			}
			await vscode.commands.executeCommand('workbench.action.files.revert');
		}),
	);
}

function activeStageEditDocument(): vscode.TextDocument | undefined {
	const document = vscode.window.activeTextEditor?.document;
	return document?.uri.scheme === SCHEME ? document : undefined;
}

/**
 * Opens the editable staged view for the SCM resource that was clicked, or for the staged diff
 * that is already in front.
 */
async function openEditableCommand(argument?: {
	resourceUri?: vscode.Uri;
}): Promise<void> {
	const staged = activeStagedTab();

	if (argument?.resourceUri) {
		await openEditableForPath(argument.resourceUri.fsPath);
		return;
	}

	if (staged) {
		await openEditableForTab(staged);
		return;
	}

	const editable = activeEditableTab();
	if (editable) {
		void vscode.window.showInformationMessage(
			'The staged changes in this editor are already editable.',
		);
		return;
	}

	void vscode.window.showInformationMessage(
		'Open a file under Staged Changes first, or run this from its context menu in the Source Control view.',
	);
}

/**
 * Opens the editable view from a working-tree path, reconstructing the HEAD side the way the
 * Git extension would: the same path for a modification, the pre-rename path for a rename, and
 * no left side at all for an addition.
 */
async function openEditableForPath(fsPath: string): Promise<void> {
	const target = await resolveTarget(fsPath);
	if (!target) {
		void vscode.window.showWarningMessage(`${fsPath} is not inside a Git repository.`);
		return;
	}

	const renamedFrom = await git.getStagedRenameSource(
		target.repositoryRoot,
		target.relativePath,
	);

	let original: vscode.Uri | undefined;
	if (renamedFrom) {
		original = toHeadUri(nodePath.join(target.repositoryRoot, renamedFrom));
	} else if (await git.existsInHead(target.repositoryRoot, target.relativePath)) {
		original = toHeadUri(nodePath.join(target.repositoryRoot, target.relativePath));
	}

	await openEditable({ target, original });
}

/**
 * Offers to turn editing on, in response to the user trying to type in the read-only staged
 * diff. VS Code raises no event for an edit attempt on a read-only editor — the editor
 * swallows the keystroke — so the keys that start an edit are bound to this command behind the
 * `stageEdit.stagedDiffActive` context key (see scripts/gen-keybindings.mjs).
 */
async function promptEnableCommand(enablement: Enablement): Promise<void> {
	const staged = activeStagedTab();
	if (!staged) {
		return;
	}

	const focused = vscode.window.activeTextEditor?.document.uri;
	if (staged.original && focused?.toString() === staged.original.toString()) {
		void vscode.window.setStatusBarMessage(
			"$(lock) That's the committed version from HEAD — the right-hand side is the staged copy.",
			4000,
		);
		return;
	}

	const target = await resolveTarget(staged.fsPath);
	if (!target) {
		return;
	}

	// Already enabled, yet here we are on a read-only diff: the automatic swap did not happen
	// for whatever reason. Asking again would be noise, so just do the thing the user is
	// plainly asking for.
	if (enablement.isEnabled(target)) {
		await openEditableForTab(staged);
		return;
	}

	if (!enablement.canPrompt(target)) {
		return;
	}

	const name = nodePath.basename(target.relativePath);
	const editThisFile = 'Edit This File';
	const always = 'Always…';
	const dontAsk = "Don't Ask Again";

	await setContext(CONTEXT_PROMPT_ACTIVE, true);
	let choice: string | undefined;
	try {
		choice = await vscode.window.showInformationMessage(
			`Staged changes are read-only by default. Make the staged copy of ${name} editable?`,
			editThisFile,
			always,
			dontAsk,
		);
	} finally {
		await setContext(CONTEXT_PROMPT_ACTIVE, false);
	}

	if (choice === editThisFile) {
		enablement.enableForSession(target);
		await swapIfStillOpen(staged);
		return;
	}

	if (choice === dontAsk) {
		await enablement.stopAsking(target);
		return;
	}

	if (choice === always) {
		await pickAlwaysScope(enablement, target, staged);
	}
}

async function pickAlwaysScope(
	enablement: Enablement,
	target: StageEditTarget,
	staged: StagedDiffTab,
): Promise<void> {
	const name = nodePath.basename(target.relativePath);
	const items: (vscode.QuickPickItem & { scope: 'file' | 'project' | 'global' })[] = [
		{
			label: `$(file) Always for ${name}`,
			description: 'this file only',
			detail: `Adds ${target.relativePath} to stageEdit.editing.alwaysForPaths.`,
			scope: 'file',
		},
		{
			label: '$(folder) Always in this project',
			description: 'workspace settings',
			detail: 'Sets stageEdit.editing.default to "always" in .vscode/settings.json.',
			scope: 'project',
		},
		{
			label: '$(globe) Always, everywhere',
			description: 'user settings',
			detail: 'Sets stageEdit.editing.default to "always" in your User settings.',
			scope: 'global',
		},
	];

	const picked = await vscode.window.showQuickPick(items, {
		title: 'Edit staged changes',
		placeHolder: 'How widely should staged changes open editable?',
	});
	if (!picked) {
		return;
	}

	if (picked.scope === 'file') {
		await enablement.enableAlwaysForPath(target);
	} else {
		await enablement.enableAlways(target, picked.scope);
	}

	await swapIfStillOpen(staged);
}

async function swapIfStillOpen(staged: StagedDiffTab): Promise<void> {
	if (isTabStillOpen(staged.tab)) {
		await openEditableForTab(staged);
	}
}

/** Persists the current file in `editing.alwaysForPaths`, from either view. */
async function alwaysForThisFileCommand(enablement: Enablement): Promise<void> {
	const staged = activeStagedTab();
	const editableDocument = activeStageEditDocument();

	const target = staged
		? await resolveTarget(staged.fsPath)
		: editableDocument
			? parseStageEditUri(editableDocument.uri)
			: undefined;

	if (!target) {
		void vscode.window.showInformationMessage('No staged file is focused.');
		return;
	}

	const configurationTarget = await enablement.enableAlwaysForPath(target);
	const where =
		configurationTarget === vscode.ConfigurationTarget.Workspace
			? 'this workspace'
			: 'your user settings';
	void vscode.window.showInformationMessage(
		`${target.relativePath} will always open editable (saved to ${where}).`,
	);

	if (staged) {
		await swapIfStillOpen(staged);
	}
}
