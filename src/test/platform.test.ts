import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as git from '../git';
import { isCaseSensitiveFileSystem, pathsEqual, targetKey, toStageEditUri } from '../uris';
import { TempRepository, createTempRepository } from './tempRepository';

suite('locating the git executable', () => {
	const missing = path.join('/definitely', 'not', 'here', 'git');

	test('falls back to PATH when nothing is configured', async () => {
		assert.equal(await git.resolveGitExecutable(undefined), 'git');
		assert.equal(await git.resolveGitExecutable(''), 'git');
		assert.equal(await git.resolveGitExecutable([]), 'git');
	});

	test('uses a configured path that exists', async () => {
		// Any real executable will do; this is about the resolution, not about git itself.
		assert.equal(await git.resolveGitExecutable(process.execPath), process.execPath);
	});

	test('falls back rather than handing back a path that is not there', async () => {
		assert.equal(await git.resolveGitExecutable(missing), 'git');
	});

	test('takes the first candidate that exists, as the Git extension does', async () => {
		assert.equal(
			await git.resolveGitExecutable([missing, process.execPath]),
			process.execPath,
		);
	});

	test('ignores blank entries', async () => {
		assert.equal(await git.resolveGitExecutable(['  ', process.execPath]), process.execPath);
	});

	test('the default is a bare git, so nothing changes without the setting', () => {
		assert.equal(git.getGitExecutable().endsWith('git'), true);
	});
});

suite('path case handling', () => {
	test('comparison follows the host filesystem', () => {
		const differentCase = pathsEqual('/Repo/Src/A.ts', '/repo/src/a.ts');
		assert.equal(
			differentCase,
			!isCaseSensitiveFileSystem(),
			'two spellings are the same file exactly when the filesystem says so',
		);
		assert.equal(pathsEqual('/repo/a.ts', '/repo/a.ts'), true);
		assert.equal(pathsEqual('/repo/a.ts', '/repo/b.ts'), false);
	});

	test('enablement keys do not split one file in two', () => {
		const lower = targetKey({ repositoryRoot: '/repo', relativePath: 'src/a.ts' });
		const upper = targetKey({ repositoryRoot: '/Repo', relativePath: 'Src/A.ts' });

		if (isCaseSensitiveFileSystem()) {
			assert.notEqual(lower, upper);
		} else {
			assert.equal(lower, upper);
		}
	});
});

suite('reading through a differently-cased URI', () => {
	let repository: TempRepository;

	suiteSetup(async () => {
		await vscode.extensions.getExtension('nmaitre.vscode-stage-edit')!.activate();
	});

	setup(async () => {
		repository = await createTempRepository();
	});

	teardown(async () => {
		await repository.dispose();
	});

	test('resolves to the same file on a case-insensitive host', async function () {
		if (isCaseSensitiveFileSystem()) {
			// On Linux the two spellings really are different files; nothing to assert.
			this.skip();
		}

		// A name of its own: on a case-insensitive host "Tracked.txt" would collide with the
		// fixture's existing tracked.txt, and the test would be about git's core.ignorecase
		// rather than about our own path folding.
		await repository.write('CasedFile.txt', 'cased\n');
		await repository.git('add', 'CasedFile.txt');

		const uri = toStageEditUri({
			repositoryRoot: repository.root,
			relativePath: 'CasedFile.txt',
		});
		// What VS Code can hand back after round-tripping a URI through its own normalisation.
		const shouted = uri.with({ path: uri.path.toUpperCase() });

		const content = await vscode.workspace.fs.readFile(shouted);
		assert.equal(Buffer.from(content).toString('utf8'), 'cased\n');
	});
});
