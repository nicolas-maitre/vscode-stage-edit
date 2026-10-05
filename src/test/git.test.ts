import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as git from '../git';
import { TempRepository, createTempRepository } from './tempRepository';

suite('git plumbing', () => {
	let repository: TempRepository;

	setup(async () => {
		repository = await createTempRepository();
	});

	teardown(async () => {
		await repository.dispose();
	});

	test('finds the repository root and relative path', async () => {
		const fsPath = path.join(repository.root, 'tracked.txt');
		assert.equal(await git.getRepositoryRoot(fsPath), repository.root);
		assert.equal(git.toRelativePath(repository.root, fsPath), 'tracked.txt');
	});

	test('reports no root outside a repository', async () => {
		assert.equal(await git.getRepositoryRoot('/'), undefined);
	});

	test('reads the staged blob, not the working-tree file', async () => {
		await repository.write('tracked.txt', 'one\nSTAGED\nthree\n');
		await repository.git('add', 'tracked.txt');
		await repository.write('tracked.txt', 'one\nWORKING\nthree\n');

		const entry = await git.getIndexEntry(repository.root, 'tracked.txt');
		assert.ok(entry);
		assert.equal(entry.mode, '100644');
		assert.equal(entry.stage, 0);

		const content = await git.readBlob(repository.root, entry.objectId);
		assert.equal(content.toString('utf8'), 'one\nSTAGED\nthree\n');
		assert.equal(await git.getBlobSize(repository.root, entry.objectId), content.byteLength);
	});

	test('writeIndexBlob updates the index and leaves the working tree alone', async () => {
		await repository.write('tracked.txt', 'one\nSTAGED\nthree\n');
		await repository.git('add', 'tracked.txt');
		await repository.write('tracked.txt', 'one\nWORKING\nthree\n');

		await git.writeIndexBlob(
			repository.root,
			'tracked.txt',
			'100644',
			Buffer.from('one\nEDITED IN THE INDEX\nthree\n', 'utf8'),
		);

		assert.equal(await repository.staged('tracked.txt'), 'one\nEDITED IN THE INDEX\nthree\n');
		assert.equal(await repository.read('tracked.txt'), 'one\nWORKING\nthree\n');
	});

	test('writeIndexBlob preserves the executable bit', async () => {
		await repository.write('script.sh', '#!/bin/sh\necho hi\n');
		await repository.git('add', '--chmod=+x', 'script.sh');

		const before = await git.getIndexEntry(repository.root, 'script.sh');
		assert.equal(before?.mode, '100755');

		await git.writeIndexBlob(
			repository.root,
			'script.sh',
			before!.mode,
			Buffer.from('#!/bin/sh\necho edited\n', 'utf8'),
		);

		const after = await git.getIndexEntry(repository.root, 'script.sh');
		assert.equal(after?.mode, '100755');
		assert.equal(await repository.staged('script.sh'), '#!/bin/sh\necho edited\n');
	});

	test('writing unchanged content is a no-op on the blob id', async () => {
		await repository.write('tracked.txt', 'one\nSTAGED\nthree\n');
		await repository.git('add', 'tracked.txt');

		const before = await git.getIndexEntry(repository.root, 'tracked.txt');
		const content = await git.readBlob(repository.root, before!.objectId);
		await git.writeIndexBlob(repository.root, 'tracked.txt', before!.mode, content);
		const after = await git.getIndexEntry(repository.root, 'tracked.txt');

		assert.equal(after?.objectId, before?.objectId);
	});

	test('no index entry for a path staged for deletion', async () => {
		await repository.git('rm', '-q', 'tracked.txt');
		assert.deepEqual(await git.getIndexEntries(repository.root, 'tracked.txt'), []);
		assert.equal(await git.getIndexEntry(repository.root, 'tracked.txt'), undefined);
	});

	test('an unmerged path has several non-zero stages', async () => {
		await repository.git('checkout', '-q', '-b', 'other');
		await repository.write('tracked.txt', 'one\nfrom other\nthree\n');
		await repository.git('commit', '-q', '-am', 'other side');
		await repository.git('checkout', '-q', 'main');
		await repository.write('tracked.txt', 'one\nfrom main\nthree\n');
		await repository.git('commit', '-q', '-am', 'main side');

		const merge = await git.run(['merge', 'other'], repository.root);
		assert.notEqual(merge.exitCode, 0, 'the merge should conflict');

		const entries = await git.getIndexEntries(repository.root, 'tracked.txt');
		assert.ok(entries.length > 1);
		assert.ok(entries.every((entry) => entry.stage !== 0));
	});

	test('detects HEAD membership and staged renames', async () => {
		assert.equal(await git.existsInHead(repository.root, 'tracked.txt'), true);
		assert.equal(await git.existsInHead(repository.root, 'nope.txt'), false);

		await repository.git('mv', 'tracked.txt', 'renamed.txt');
		assert.equal(
			await git.getStagedRenameSource(repository.root, 'renamed.txt'),
			'tracked.txt',
		);
		assert.equal(await git.getStagedRenameSource(repository.root, 'tracked.txt'), undefined);
	});
});
