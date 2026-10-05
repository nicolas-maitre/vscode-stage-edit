import { spawn } from 'node:child_process';
import * as path from 'node:path';

export class GitError extends Error {
	constructor(
		message: string,
		readonly args: readonly string[],
		readonly exitCode: number,
		readonly stderr: string,
	) {
		super(message);
	}
}

export interface GitOutput {
	stdout: Buffer;
	stderr: string;
	exitCode: number;
}

/**
 * Runs git with the given arguments. Output is kept as a Buffer because blob contents are
 * read and written verbatim — anything that round-trips through a JS string would corrupt
 * files that are not valid UTF-8.
 */
export function run(args: readonly string[], cwd: string, stdin?: Buffer): Promise<GitOutput> {
	return new Promise((resolve, reject) => {
		const child = spawn('git', args as string[], {
			cwd,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
		});

		const stdoutChunks: Buffer[] = [];
		let stderr = '';

		child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			stderr += chunk;
		});

		child.on('error', reject);
		child.on('close', (code) => {
			resolve({ stdout: Buffer.concat(stdoutChunks), stderr, exitCode: code ?? -1 });
		});

		if (stdin) {
			child.stdin.end(stdin);
		} else {
			child.stdin.end();
		}
	});
}

async function runOrThrow(args: readonly string[], cwd: string, stdin?: Buffer): Promise<GitOutput> {
	const result = await run(args, cwd, stdin);
	if (result.exitCode !== 0) {
		throw new GitError(
			`git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.trim()}`,
			args,
			result.exitCode,
			result.stderr,
		);
	}
	return result;
}

async function text(args: readonly string[], cwd: string): Promise<string> {
	const { stdout } = await runOrThrow(args, cwd);
	return stdout.toString('utf8').trim();
}

/** Absolute path of the repository root containing `fsPath`, or undefined if there is none. */
export async function getRepositoryRoot(fsPath: string): Promise<string | undefined> {
	const cwd = path.dirname(fsPath);
	const result = await run(['rev-parse', '--show-toplevel'], cwd);
	if (result.exitCode !== 0) {
		return undefined;
	}
	const root = result.stdout.toString('utf8').trim();
	return root.length > 0 ? root : undefined;
}

/** Repository-relative, forward-slashed path, as git itself spells it. */
export function toRelativePath(repositoryRoot: string, fsPath: string): string {
	return path.relative(repositoryRoot, fsPath).split(path.sep).join('/');
}

export interface IndexEntry {
	/** Octal file mode: 100644, 100755, 120000 (symlink) or 160000 (submodule). */
	mode: string;
	objectId: string;
	/** 0 for a normal entry; 1/2/3 for the stages of an unmerged path. */
	stage: number;
	relativePath: string;
}

/**
 * Index entries for one path. A merge conflict yields several entries (stages 1-3); a path
 * staged for deletion, or not staged at all, yields none.
 */
export async function getIndexEntries(
	repositoryRoot: string,
	relativePath: string,
): Promise<IndexEntry[]> {
	const { stdout } = await runOrThrow(
		['ls-files', '--stage', '-z', '--', relativePath],
		repositoryRoot,
	);

	const entries: IndexEntry[] = [];
	for (const record of stdout.toString('utf8').split('\0')) {
		if (record.length === 0) {
			continue;
		}
		// "<mode> <objectId> <stage>\t<path>"
		const tab = record.indexOf('\t');
		if (tab === -1) {
			continue;
		}
		const [mode, objectId, stage] = record.slice(0, tab).split(' ');
		entries.push({
			mode,
			objectId,
			stage: Number(stage),
			relativePath: record.slice(tab + 1),
		});
	}
	return entries;
}

/** The single stage-0 index entry for a path, or undefined if there isn't exactly one. */
export async function getIndexEntry(
	repositoryRoot: string,
	relativePath: string,
): Promise<IndexEntry | undefined> {
	const entries = await getIndexEntries(repositoryRoot, relativePath);
	if (entries.length !== 1 || entries[0].stage !== 0) {
		return undefined;
	}
	return entries[0];
}

export async function readBlob(repositoryRoot: string, objectId: string): Promise<Buffer> {
	const { stdout } = await runOrThrow(['cat-file', 'blob', objectId], repositoryRoot);
	return stdout;
}

export async function getBlobSize(repositoryRoot: string, objectId: string): Promise<number> {
	return Number(await text(['cat-file', '-s', objectId], repositoryRoot));
}

/**
 * Stores `content` as a blob and points the index entry for `relativePath` at it, keeping the
 * existing file mode. The working tree is not touched.
 *
 * The blob is written with a bare `hash-object --stdin`, which applies no clean filters. That
 * is deliberate and symmetric with {@link readBlob}: the bytes shown in the editor are the
 * blob's own bytes, so writing them back unchanged must be a no-op. Passing `--path` here
 * would re-run the clean filter over already-cleaned content and, for a repository using e.g.
 * CRLF normalisation, quietly rewrite every line ending.
 */
export async function writeIndexBlob(
	repositoryRoot: string,
	relativePath: string,
	mode: string,
	content: Buffer,
): Promise<string> {
	const objectId = (
		await runOrThrow(['hash-object', '-w', '--stdin'], repositoryRoot, content)
	).stdout
		.toString('utf8')
		.trim();

	await runOrThrow(
		['update-index', '--cacheinfo', `${mode},${objectId},${relativePath}`],
		repositoryRoot,
	);

	return objectId;
}

/** True when `relativePath` exists in HEAD. */
export async function existsInHead(
	repositoryRoot: string,
	relativePath: string,
): Promise<boolean> {
	const result = await run(['cat-file', '-e', `HEAD:${relativePath}`], repositoryRoot);
	return result.exitCode === 0;
}

/**
 * If `relativePath` is staged as a rename, the path it was renamed from. Used to find the HEAD
 * side of the diff when the request came from the Source Control view rather than from a tab
 * the Git extension already built the URIs for.
 */
export async function getStagedRenameSource(
	repositoryRoot: string,
	relativePath: string,
): Promise<string | undefined> {
	const result = await run(
		['diff', '--cached', '--name-status', '-M', '-z', '--diff-filter=R'],
		repositoryRoot,
	);
	if (result.exitCode !== 0) {
		return undefined;
	}

	// NUL-separated, three fields per rename: "R<score>", old path, new path.
	const fields = result.stdout.toString('utf8').split('\0');
	for (let i = 0; i + 2 < fields.length; i += 3) {
		if (!fields[i].startsWith('R')) {
			break;
		}
		if (fields[i + 2] === relativePath) {
			return fields[i + 1];
		}
	}
	return undefined;
}

/**
 * Whether the working-tree file matches its index entry.
 *
 * Asked of git rather than by comparing bytes ourselves, because the two are legitimately
 * different on disk whenever a clean/smudge filter is in play — a repository with
 * `text=auto` and CRLF checkout stores LF blobs and checks out CRLF files. A byte comparison
 * would call every such file dirty.
 */
export async function isWorkingTreeFileClean(
	repositoryRoot: string,
	relativePath: string,
): Promise<boolean> {
	// --quiet implies --exit-code: 0 means no difference, 1 means there is one.
	const result = await run(['diff', '--quiet', '--', relativePath], repositoryRoot);
	return result.exitCode === 0;
}

/**
 * Writes the working-tree file from its index entry, applying smudge filters and the recorded
 * file mode. Using git for this instead of writing the blob bytes ourselves is what keeps line
 * endings, symlinks and the executable bit correct.
 */
export async function checkoutIndexToWorkingTree(
	repositoryRoot: string,
	relativePath: string,
): Promise<void> {
	await runOrThrow(['checkout-index', '-f', '--', relativePath], repositoryRoot);
}
