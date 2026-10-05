import * as assert from 'node:assert/strict';
import * as git from '../git';
import { coerceSyncWorkingTree } from '../enablement';
import { TempRepository, createTempRepository } from './tempRepository';

suite('working-tree sync primitives', () => {
	let repository: TempRepository;

	setup(async () => {
		repository = await createTempRepository();
	});

	teardown(async () => {
		await repository.dispose();
	});

	test('a file matching its index entry is clean', async () => {
		assert.equal(await git.isWorkingTreeFileClean(repository.root, 'tracked.txt'), true);
	});

	test('a file with unstaged changes is not', async () => {
		await repository.write('tracked.txt', 'one\nWORKING\nthree\n');
		assert.equal(await git.isWorkingTreeFileClean(repository.root, 'tracked.txt'), false);
	});

	test('a file deleted from disk is not clean, so a sync will not resurrect it', async () => {
		await repository.git('rm', '--cached', '-q', 'tracked.txt');
		await repository.git('add', 'tracked.txt');
		await repository.write('tracked.txt', 'one\ntwo\nthree\n');
		assert.equal(await git.isWorkingTreeFileClean(repository.root, 'tracked.txt'), true);

		await repository.remove('tracked.txt');
		assert.equal(await git.isWorkingTreeFileClean(repository.root, 'tracked.txt'), false);
	});

	test('a staged-only edit leaves the file dirty relative to the index', async () => {
		// This is the state the extension creates: index moved, disk did not follow.
		await git.writeIndexBlob(
			repository.root,
			'tracked.txt',
			'100644',
			Buffer.from('one\nSTAGED ONLY\nthree\n', 'utf8'),
		);
		assert.equal(await git.isWorkingTreeFileClean(repository.root, 'tracked.txt'), false);
	});

	test('checkout-index writes the file back from the index', async () => {
		await git.writeIndexBlob(
			repository.root,
			'tracked.txt',
			'100644',
			Buffer.from('from the index\n', 'utf8'),
		);
		await git.checkoutIndexToWorkingTree(repository.root, 'tracked.txt');

		assert.equal(await repository.read('tracked.txt'), 'from the index\n');
		assert.equal(await git.isWorkingTreeFileClean(repository.root, 'tracked.txt'), true);
	});

	test('checkout-index respects a CRLF checkout rule', async () => {
		await repository.write('.gitattributes', '*.txt text eol=crlf\n');
		await repository.git('add', '.gitattributes');
		await repository.git('commit', '-q', '-m', 'crlf rule');

		await git.writeIndexBlob(
			repository.root,
			'tracked.txt',
			'100644',
			Buffer.from('alpha\nbeta\n', 'utf8'),
		);
		await git.checkoutIndexToWorkingTree(repository.root, 'tracked.txt');

		// The blob keeps LF; the file on disk gets CRLF. Writing the blob bytes ourselves would
		// have produced an LF file and an immediate phantom unstaged diff.
		assert.equal(await repository.read('tracked.txt'), 'alpha\r\nbeta\r\n');
		assert.equal(await repository.staged('tracked.txt'), 'alpha\nbeta\n');
		assert.equal(await git.isWorkingTreeFileClean(repository.root, 'tracked.txt'), true);
	});

	test('checkout-index keeps the executable bit', async () => {
		await repository.write('script.sh', '#!/bin/sh\necho hi\n');
		await repository.git('add', '--chmod=+x', 'script.sh');
		await git.writeIndexBlob(
			repository.root,
			'script.sh',
			'100755',
			Buffer.from('#!/bin/sh\necho edited\n', 'utf8'),
		);

		await git.checkoutIndexToWorkingTree(repository.root, 'script.sh');

		assert.equal(await repository.read('script.sh'), '#!/bin/sh\necho edited\n');
		assert.equal(await repository.isExecutable('script.sh'), true);
	});
});

suite('syncWorkingTree setting', () => {
	test('accepts the four modes', () => {
		assert.equal(coerceSyncWorkingTree('askWhenDirty'), 'askWhenDirty');
		assert.equal(coerceSyncWorkingTree('whenSafe'), 'whenSafe');
		assert.equal(coerceSyncWorkingTree('never'), 'never');
		assert.equal(coerceSyncWorkingTree('always'), 'always');
	});

	test('still understands the booleans it used to be', () => {
		assert.equal(coerceSyncWorkingTree(true), 'always');
		assert.equal(coerceSyncWorkingTree(false), 'never');
	});

	test('falls back to the strict mode for anything unexpected', () => {
		assert.equal(coerceSyncWorkingTree(undefined), 'askWhenDirty');
		assert.equal(coerceSyncWorkingTree('nonsense'), 'askWhenDirty');
	});
});
