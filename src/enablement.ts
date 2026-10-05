import * as vscode from 'vscode';
import { minimatch } from 'minimatch';
import { StageEditTarget, targetKey } from './uris';

export type EditingDefault = 'prompt' | 'always' | 'never';
export type ApplyMode = 'onSave' | 'live';

/**
 * How far the working tree follows an edit to the staged copy, and what happens when it
 * cannot follow without losing something.
 *
 * `askWhenDirty` is the default and the strictest of the four: the staged copy and the file on
 * disk are kept in step, and rather than letting them drift it refuses the save outright when
 * the file has unstaged changes, offering to overwrite them. The other three never refuse a
 * save — they differ only in whether the file on disk is written.
 */
export type SyncWorkingTree = 'askWhenDirty' | 'never' | 'whenSafe' | 'always';

/** Scope a user picked when turning editing on. */
export type EnableScope = 'session' | 'project' | 'global';

function configurationFor(target: StageEditTarget): vscode.WorkspaceConfiguration {
	const resource = vscode.Uri.file(`${target.repositoryRoot}/${target.relativePath}`);
	return vscode.workspace.getConfiguration('stageEdit', resource);
}

export interface ApplySettings {
	mode: ApplyMode;
	liveDebounce: number;
	syncWorkingTree: SyncWorkingTree;
}

const SYNC_MODES: readonly SyncWorkingTree[] = ['askWhenDirty', 'never', 'whenSafe', 'always'];

/** The setting used to be a boolean; keep an older value in settings.json working. */
export function coerceSyncWorkingTree(value: unknown): SyncWorkingTree {
	if (value === true) {
		return 'always';
	}
	if (value === false) {
		return 'never';
	}
	return SYNC_MODES.includes(value as SyncWorkingTree)
		? (value as SyncWorkingTree)
		: 'askWhenDirty';
}

export function applySettings(target: StageEditTarget): ApplySettings {
	const config = configurationFor(target);
	return {
		mode: config.get<ApplyMode>('apply.mode', 'onSave'),
		liveDebounce: config.get<number>('apply.liveDebounce', 500),
		syncWorkingTree: coerceSyncWorkingTree(config.get<unknown>('apply.syncWorkingTree')),
	};
}

/**
 * Tracks whether editing the staged side is turned on for a given file, across the three
 * scopes the user can choose from: this file for the rest of the session, this file
 * persistently (a glob in settings), and everything (the `editing.default` setting, which is
 * itself per-project when written to workspace settings and global when written to user
 * settings).
 */
export class Enablement {
	private readonly sessionEnabled = new Set<string>();
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	private readonly disposable: vscode.Disposable;

	constructor() {
		this.disposable = vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('stageEdit.editing')) {
				this.onDidChangeEmitter.fire();
			}
		});
	}

	dispose(): void {
		this.disposable.dispose();
		this.onDidChangeEmitter.dispose();
	}

	editingDefault(target: StageEditTarget): EditingDefault {
		return configurationFor(target).get<EditingDefault>('editing.default', 'prompt');
	}

	/** True when a staged diff for this file should open editable without asking. */
	isEnabled(target: StageEditTarget): boolean {
		if (this.editingDefault(target) === 'never') {
			return false;
		}
		if (this.sessionEnabled.has(targetKey(target))) {
			return true;
		}
		if (this.editingDefault(target) === 'always') {
			return true;
		}
		return this.matchesAlwaysForPaths(target);
	}

	/** True when we may offer to turn editing on for this file. */
	canPrompt(target: StageEditTarget): boolean {
		return this.editingDefault(target) === 'prompt' && !this.isEnabled(target);
	}

	private matchesAlwaysForPaths(target: StageEditTarget): boolean {
		const patterns = configurationFor(target).get<string[]>('editing.alwaysForPaths', []);
		return patterns.some((pattern) => minimatch(target.relativePath, pattern, { dot: true }));
	}

	enableForSession(target: StageEditTarget): void {
		this.sessionEnabled.add(targetKey(target));
		this.onDidChangeEmitter.fire();
	}

	disableForSession(target: StageEditTarget): void {
		this.sessionEnabled.delete(targetKey(target));
		this.onDidChangeEmitter.fire();
	}

	/** Persists `editing.default = always` at workspace or user level. */
	async enableAlways(target: StageEditTarget, scope: 'project' | 'global'): Promise<void> {
		const configurationTarget =
			scope === 'project' && vscode.workspace.workspaceFolders?.length
				? vscode.ConfigurationTarget.Workspace
				: vscode.ConfigurationTarget.Global;
		await configurationFor(target).update('editing.default', 'always', configurationTarget);
	}

	/** Adds this one file to `editing.alwaysForPaths`. */
	async enableAlwaysForPath(target: StageEditTarget): Promise<vscode.ConfigurationTarget> {
		const config = configurationFor(target);
		const inspected = config.inspect<string[]>('editing.alwaysForPaths');
		const configurationTarget = vscode.workspace.workspaceFolders?.length
			? vscode.ConfigurationTarget.Workspace
			: vscode.ConfigurationTarget.Global;

		const existing =
			(configurationTarget === vscode.ConfigurationTarget.Workspace
				? inspected?.workspaceValue
				: inspected?.globalValue) ?? [];

		if (!existing.includes(target.relativePath)) {
			await config.update(
				'editing.alwaysForPaths',
				[...existing, target.relativePath],
				configurationTarget,
			);
		}
		return configurationTarget;
	}

	async stopAsking(target: StageEditTarget): Promise<void> {
		await configurationFor(target).update(
			'editing.default',
			'never',
			vscode.ConfigurationTarget.Global,
		);
	}
}
