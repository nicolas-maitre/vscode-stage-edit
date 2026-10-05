import * as vscode from 'vscode';
import * as git from './git';

/** Scheme of our writable view onto the Git index. */
export const SCHEME = 'stage-edit';

/**
 * Query payload the built-in Git extension puts on its `git:` URIs. `path` is the absolute
 * path of the file in the working tree; `ref` selects the version: `HEAD`, a commit-ish, or
 * the empty string for the index.
 */
interface GitUriParams {
	path: string;
	ref: string;
	submoduleOf?: string;
}

export function parseGitUri(uri: vscode.Uri): GitUriParams | undefined {
	if (uri.scheme !== 'git' || uri.query.length === 0) {
		return undefined;
	}
	try {
		const params = JSON.parse(uri.query) as GitUriParams;
		return typeof params?.path === 'string' && typeof params?.ref === 'string'
			? params
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether a `git:` URI points at the index.
 *
 * Only the empty ref counts. The Git extension also uses `~`, which means "the index version
 * if the file is staged, otherwise HEAD" — that one appears on the *left* side of a
 * working-tree diff, and treating it as the index here would make us mistake every unstaged
 * diff for a staged one.
 */
export function isIndexUri(uri: vscode.Uri): boolean {
	return parseGitUri(uri)?.ref === '';
}

/** The working-tree path a `git:` URI refers to, as an absolute filesystem path. */
export function gitUriFsPath(uri: vscode.Uri): string | undefined {
	return parseGitUri(uri)?.path;
}

export interface StageEditTarget {
	repositoryRoot: string;
	relativePath: string;
}

export function toStageEditUri(target: StageEditTarget): vscode.Uri {
	// Keep the real file path so the editor picks the right language mode and the tab shows a
	// familiar name; the query carries what the filesystem provider actually needs.
	const fsPath = `${target.repositoryRoot}/${target.relativePath}`;
	return vscode.Uri.file(fsPath).with({
		scheme: SCHEME,
		query: JSON.stringify({ root: target.repositoryRoot, rel: target.relativePath }),
	});
}

export function parseStageEditUri(uri: vscode.Uri): StageEditTarget | undefined {
	if (uri.scheme !== SCHEME || uri.query.length === 0) {
		return undefined;
	}
	try {
		const { root, rel } = JSON.parse(uri.query) as { root?: unknown; rel?: unknown };
		return typeof root === 'string' && typeof rel === 'string'
			? { repositoryRoot: root, relativePath: rel }
			: undefined;
	} catch {
		return undefined;
	}
}

/** Resolves an absolute working-tree path to a repository root plus relative path. */
export async function resolveTarget(fsPath: string): Promise<StageEditTarget | undefined> {
	const repositoryRoot = await git.getRepositoryRoot(fsPath);
	if (!repositoryRoot) {
		return undefined;
	}
	return { repositoryRoot, relativePath: git.toRelativePath(repositoryRoot, fsPath) };
}

export function targetKey(target: StageEditTarget): string {
	return `${target.repositoryRoot}::${target.relativePath}`;
}

/**
 * Builds the `git:` URI for a file's HEAD version, in the exact shape the built-in Git
 * extension produces. Only needed when a request comes from the Source Control view; when it
 * comes from an open tab we reuse the extension's own URI untouched.
 */
export function toHeadUri(fsPath: string): vscode.Uri {
	return vscode.Uri.file(fsPath).with({
		scheme: 'git',
		query: JSON.stringify({ path: fsPath, ref: 'HEAD' }),
	});
}
