import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from '../git';

export interface TempRepository {
	root: string;
	write(relativePath: string, content: string): Promise<void>;
	read(relativePath: string): Promise<string>;
	remove(relativePath: string): Promise<void>;
	symlink(relativePath: string, pointsTo: string): Promise<void>;
	readLink(relativePath: string): Promise<string>;
	isExecutable(relativePath: string): Promise<boolean>;
	git(...args: string[]): Promise<string>;
	/** Content of a path as it currently stands in the index. */
	staged(relativePath: string): Promise<string>;
	dispose(): Promise<void>;
}

/** Creates a throwaway repository with one commit, for tests that need real git state. */
export async function createTempRepository(): Promise<TempRepository> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stage-edit-test-'));
	// macOS puts temp dirs under a symlinked /var; resolving it up front keeps paths
	// comparable with what `git rev-parse --show-toplevel` reports.
	const realRoot = await fs.realpath(root);

	const repository: TempRepository = {
		root: realRoot,
		async write(relativePath, content) {
			const target = path.join(realRoot, relativePath);
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.writeFile(target, content, 'utf8');
		},
		async read(relativePath) {
			return fs.readFile(path.join(realRoot, relativePath), 'utf8');
		},
		async remove(relativePath) {
			await fs.rm(path.join(realRoot, relativePath));
		},
		async symlink(relativePath, pointsTo) {
			await fs.symlink(pointsTo, path.join(realRoot, relativePath));
		},
		async readLink(relativePath) {
			return fs.readlink(path.join(realRoot, relativePath));
		},
		async isExecutable(relativePath) {
			const stats = await fs.stat(path.join(realRoot, relativePath));
			return (stats.mode & 0o111) !== 0;
		},
		async git(...args) {
			const result = await run(args, realRoot);
			if (result.exitCode !== 0) {
				throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
			}
			return result.stdout.toString('utf8');
		},
		async staged(relativePath) {
			return repository.git('show', `:${relativePath}`);
		},
		async dispose() {
			await fs.rm(realRoot, { recursive: true, force: true });
		},
	};

	await repository.git('init', '-q', '-b', 'main');
	await repository.git('config', 'user.email', 'test@example.com');
	await repository.git('config', 'user.name', 'Stage Edit Test');
	await repository.git('config', 'commit.gpgsign', 'false');

	await repository.write('tracked.txt', 'one\ntwo\nthree\n');
	await repository.git('add', 'tracked.txt');
	await repository.git('commit', '-q', '-m', 'initial');

	return repository;
}
