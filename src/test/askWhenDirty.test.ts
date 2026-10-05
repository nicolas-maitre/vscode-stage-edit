import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import * as git from '../git';
import { ConfirmDirtyApply, DirtyFileAnswer, IndexFileSystemProvider } from '../indexFs';
import { toStageEditUri } from '../uris';
import { TempRepository, createTempRepository } from './tempRepository';

/**
 * Drives the provider directly with a stubbed confirmation, so the refusal path can be tested
 * without a modal dialog sitting in front of the test run.
 */
suite('askWhenDirty', () => {
	let repository: TempRepository;
	let provider: IndexFileSystemProvider;
	let asked: number;
	let answer: DirtyFileAnswer;

	setup(async () => {
		repository = await createTempRepository();
		asked = 0;
		answer = 'cancel';

		const confirm: ConfirmDirtyApply = async () => {
			asked += 1;
			return answer;
		};
		provider = new IndexFileSystemProvider(confirm);

		// askWhenDirty is the default, but pin it so the test does not depend on that.
		await vscode.workspace
			.getConfiguration('stageEdit')
			.update('apply.syncWorkingTree', 'askWhenDirty', vscode.ConfigurationTarget.Global);
	});

	teardown(async () => {
		provider.dispose();
		await vscode.workspace
			.getConfiguration('stageEdit')
			.update('apply.syncWorkingTree', undefined, vscode.ConfigurationTarget.Global);
		await repository.dispose();
	});

	function uriFor(relativePath: string): vscode.Uri {
		return toStageEditUri({ repositoryRoot: repository.root, relativePath });
	}

	function write(relativePath: string, content: string): Promise<void> {
		return provider.writeFile(uriFor(relativePath), Buffer.from(content, 'utf8'));
	}

	test('a clean file saves and the working tree follows, with no question asked', async () => {
		await write('tracked.txt', 'one\nEDITED\nthree\n');

		assert.equal(asked, 0);
		assert.equal(await repository.staged('tracked.txt'), 'one\nEDITED\nthree\n');
		assert.equal(await repository.read('tracked.txt'), 'one\nEDITED\nthree\n');
	});

	test('a dirty file asks, and declining leaves the index completely untouched', async () => {
		await repository.write('tracked.txt', 'one\nUNSTAGED WORK\nthree\n');
		const before = await git.getIndexEntry(repository.root, 'tracked.txt');
		answer = 'cancel';

		await assert.rejects(() => write('tracked.txt', 'one\nEDITED\nthree\n'));

		assert.equal(asked, 1);
		// The whole point of deciding before writing: a refused save is not half-applied.
		const after = await git.getIndexEntry(repository.root, 'tracked.txt');
		assert.equal(after?.objectId, before?.objectId, 'the index did not move');
		assert.equal(await repository.read('tracked.txt'), 'one\nUNSTAGED WORK\nthree\n');
	});

	test('accepting overwrites the file and stages the edit', async () => {
		await repository.write('tracked.txt', 'one\nUNSTAGED WORK\nthree\n');
		answer = 'overwrite';

		await write('tracked.txt', 'one\nEDITED\nthree\n');

		assert.equal(asked, 1);
		assert.equal(await repository.staged('tracked.txt'), 'one\nEDITED\nthree\n');
		assert.equal(await repository.read('tracked.txt'), 'one\nEDITED\nthree\n');
	});

	test('overwriting once leaves the file in step, so the next save asks nothing', async () => {
		await repository.write('tracked.txt', 'one\nUNSTAGED WORK\nthree\n');
		answer = 'overwrite';
		await write('tracked.txt', 'one\nFIRST\nthree\n');
		assert.equal(asked, 1);

		await write('tracked.txt', 'one\nSECOND\nthree\n');

		assert.equal(asked, 1, 'no second question');
		assert.equal(await repository.staged('tracked.txt'), 'one\nSECOND\nthree\n');
		assert.equal(await repository.read('tracked.txt'), 'one\nSECOND\nthree\n');
	});

	test('choosing index-only stages the edit and leaves the file alone', async () => {
		await repository.write('tracked.txt', 'one\nUNSTAGED WORK\nthree\n');
		answer = 'index-only';

		await write('tracked.txt', 'one\nEDITED\nthree\n');

		assert.equal(asked, 1);
		assert.equal(await repository.staged('tracked.txt'), 'one\nEDITED\nthree\n');
		assert.equal(
			await repository.read('tracked.txt'),
			'one\nUNSTAGED WORK\nthree\n',
			'the unstaged work survives',
		);
	});

	test('index-only leaves the file dirty, so the next save asks again', async () => {
		await repository.write('tracked.txt', 'one\nUNSTAGED WORK\nthree\n');
		answer = 'index-only';
		await write('tracked.txt', 'one\nFIRST\nthree\n');
		assert.equal(asked, 1);

		await write('tracked.txt', 'one\nSECOND\nthree\n');

		// Unlike overwriting, this choice does not put the two back in step, so the question is
		// still live next time. Each save is answered on its own.
		assert.equal(asked, 2);
		assert.equal(await repository.staged('tracked.txt'), 'one\nSECOND\nthree\n');
		assert.equal(await repository.read('tracked.txt'), 'one\nUNSTAGED WORK\nthree\n');
	});

	test('an automatic apply is held back without asking anything', async () => {
		await repository.write('tracked.txt', 'one\nUNSTAGED WORK\nthree\n');
		const before = await git.getIndexEntry(repository.root, 'tracked.txt');

		provider.markAutomaticApply(uriFor('tracked.txt'));
		await assert.rejects(() => write('tracked.txt', 'one\nEDITED\nthree\n'));

		assert.equal(asked, 0, 'no modal mid-keystroke');
		const after = await git.getIndexEntry(repository.root, 'tracked.txt');
		assert.equal(after?.objectId, before?.objectId);
	});

	test('the automatic marker is one-shot, so the next explicit save does ask', async () => {
		await repository.write('tracked.txt', 'one\nUNSTAGED WORK\nthree\n');
		provider.markAutomaticApply(uriFor('tracked.txt'));
		await assert.rejects(() => write('tracked.txt', 'one\nEDITED\nthree\n'));

		answer = 'overwrite';
		await write('tracked.txt', 'one\nEDITED\nthree\n');

		assert.equal(asked, 1);
		assert.equal(await repository.staged('tracked.txt'), 'one\nEDITED\nthree\n');
	});

	test('a symlink is never written over, and never blocks the save', async () => {
		await repository.symlink('link.txt', 'tracked.txt');
		await repository.git('add', 'link.txt');
		const entry = await git.getIndexEntry(repository.root, 'link.txt');
		assert.equal(entry?.mode, '120000', 'staged as a symlink');

		await write('link.txt', 'elsewhere.txt');

		assert.equal(asked, 0);
		assert.equal(await repository.staged('link.txt'), 'elsewhere.txt');
		assert.equal(await repository.readLink('link.txt'), 'tracked.txt', 'the link itself is intact');
	});
});
