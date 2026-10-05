import * as vscode from 'vscode';
import * as nodePath from 'node:path';
import { checkEditability } from './editability';
import {
	SCHEME,
	StageEditTarget,
	gitUriFsPath,
	isIndexUri,
	resolveTarget,
	toStageEditUri,
} from './uris';

export interface StagedDiffTab {
	tab: vscode.Tab;
	/** Left-hand side, when there is one. A staged *addition* opens without one. */
	original: vscode.Uri | undefined;
	/** Right-hand side: the index version, served read-only by the Git extension. */
	modified: vscode.Uri;
	fsPath: string;
}

/**
 * Recognises the Git extension's read-only view of a staged change.
 *
 * Both shapes it opens are handled: a diff for a staged modification or rename, and a plain
 * editor for a staged addition — for an addition there is no HEAD blob, so the Git extension
 * skips the diff and opens the index version on its own.
 */
export function describeStagedTab(tab: vscode.Tab | undefined): StagedDiffTab | undefined {
	if (!tab) {
		return undefined;
	}

	if (tab.input instanceof vscode.TabInputTextDiff) {
		const { original, modified } = tab.input;
		const fsPath = gitUriFsPath(modified);
		if (isIndexUri(modified) && fsPath) {
			return { tab, original, modified, fsPath };
		}
		return undefined;
	}

	if (tab.input instanceof vscode.TabInputText) {
		const { uri } = tab.input;
		const fsPath = gitUriFsPath(uri);
		if (isIndexUri(uri) && fsPath) {
			return { tab, original: undefined, modified: uri, fsPath };
		}
	}

	return undefined;
}

export function activeStagedTab(): StagedDiffTab | undefined {
	return describeStagedTab(vscode.window.tabGroups.activeTabGroup.activeTab);
}

/** Whether the active tab already shows our editable view. */
export function activeEditableTab(): vscode.Tab | undefined {
	const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
	if (!tab) {
		return undefined;
	}
	if (tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === SCHEME) {
		return tab;
	}
	if (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === SCHEME) {
		return tab;
	}
	return undefined;
}

export interface OpenEditableOptions {
	target: StageEditTarget;
	/** Kept exactly as the Git extension produced it, which is what makes renames work. */
	original?: vscode.Uri | undefined;
	viewColumn?: vscode.ViewColumn;
	/** Read-only tab to close once the editable one is open. */
	replacing?: vscode.Tab | undefined;
}

/**
 * Opens the editable staged view, replacing the read-only tab when there is one.
 *
 * Returns false when git's state rules the file out — staged deletions, unmerged paths,
 * submodules and binaries keep the stock read-only diff, with an explanation.
 */
export async function openEditable(options: OpenEditableOptions): Promise<boolean> {
	const { target } = options;
	const editability = await checkEditability(target);

	if (!editability.editable) {
		void vscode.window.showWarningMessage(
			`Can't edit the staged copy of ${nodePath.basename(target.relativePath)}: ${editability.reason}.`,
		);
		return false;
	}

	const editableUri = toStageEditUri(target);
	const title = `${nodePath.basename(target.relativePath)} (Index, editable)`;
	const viewColumn = options.viewColumn ?? vscode.ViewColumn.Active;

	if (options.original) {
		await vscode.commands.executeCommand(
			'vscode.diff',
			options.original,
			editableUri,
			title,
			{ viewColumn, preview: false } satisfies vscode.TextDocumentShowOptions,
		);
	} else {
		await vscode.commands.executeCommand('vscode.open', editableUri, {
			viewColumn,
			preview: false,
		} satisfies vscode.TextDocumentShowOptions);
	}

	// Closed after the replacement is up, so the editor group never blinks empty.
	if (options.replacing) {
		await vscode.window.tabGroups.close(options.replacing, true);
	}

	return true;
}

/**
 * Swaps in progress, keyed by the read-only tab being replaced.
 *
 * Both the prompt and the tab watcher can decide to swap the same tab at nearly the same
 * moment — enabling editing fires the watcher as well — and without this the two would race
 * and leave two editable tabs behind.
 */
const inFlight = new Set<string>();

/**
 * Why a swap did not happen.
 *
 * `raced` and `gone` are transient and say nothing about the file, so callers must not
 * remember them — treating them as permanent failures is what used to poison a file's URI for
 * the rest of the session, leaving it stuck on the read-only diff.
 */
export type SwapResult =
	| 'opened'
	/** Another swap for the same tab was already under way. */
	| 'raced'
	/** The tab closed while we were working out what to open. */
	| 'gone'
	/** Git's state rules this file out: staged deletion, unmerged, submodule, binary. */
	| 'unsupported'
	| 'not-a-repository';

/** Opens the editable view for a read-only staged tab we already recognised. */
export async function openEditableForTab(staged: StagedDiffTab): Promise<SwapResult> {
	const key = staged.modified.toString();
	if (inFlight.has(key)) {
		return 'raced';
	}
	inFlight.add(key);

	try {
		const target = await resolveTarget(staged.fsPath);
		if (!target) {
			void vscode.window.showWarningMessage(
				`${staged.fsPath} is not inside a Git repository.`,
			);
			return 'not-a-repository';
		}

		if (!isTabStillOpen(staged.tab)) {
			return 'gone';
		}

		const opened = await openEditable({
			target,
			original: staged.original,
			viewColumn: staged.tab.group.viewColumn,
			replacing: staged.tab,
		});
		return opened ? 'opened' : 'unsupported';
	} finally {
		inFlight.delete(key);
	}
}

/** True while the tab is still open somewhere, so a slow async path can bail out safely. */
export function isTabStillOpen(tab: vscode.Tab): boolean {
	return vscode.window.tabGroups.all.some((group) => group.tabs.includes(tab));
}
