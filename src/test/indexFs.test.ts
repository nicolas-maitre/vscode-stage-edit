import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { checkEditability } from '../editability';
import { toStageEditUri } from '../uris';
import { TempRepository, createTempRepository } from './tempRepository';

const EXTENSION_ID = 'nmaitre.vscode-stage-edit';

suite('stage-edit filesystem', () => {
	let repository: TempRepository;

	suiteSetup(async () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(extension, `${EXTENSION_ID} should be present in the test instance`);
		await extension.activate();
	});

	// These assertions are about index-only writes, so pin the mode rather than inheriting the
	// default — askWhenDirty would raise a modal on a dirty file and stall the run.
	suiteSetup(async () => {
		await vscode.workspace
			.getConfiguration('stageEdit')
			.update('apply.syncWorkingTree', 'whenSafe', vscode.ConfigurationTarget.Global);
	});

	suiteTeardown(async () => {
		await vscode.workspace
			.getConfiguration('stageEdit')
			.update('apply.syncWorkingTree', undefined, vscode.ConfigurationTarget.Global);
	});

	setup(async () => {
		repository = await createTempRepository();
	});

	teardown(async () => {
		await repository.dispose();
	});

	function uriFor(relativePath: string): vscode.Uri {
		return toStageEditUri({ repositoryRoot: repository.root, relativePath });
	}

	test('reads the staged content through the provider', async () => {
		await repository.write('tracked.txt', 'one\nSTAGED\nthree\n');
		await repository.git('add', 'tracked.txt');
		await repository.write('tracked.txt', 'one\nWORKING\nthree\n');

		const bytes = await vscode.workspace.fs.readFile(uriFor('tracked.txt'));
		assert.equal(Buffer.from(bytes).toString('utf8'), 'one\nSTAGED\nthree\n');

		const stat = await vscode.workspace.fs.stat(uriFor('tracked.txt'));
		assert.equal(stat.type, vscode.FileType.File);
		assert.equal(stat.size, bytes.byteLength);
	});

	test('writing through the provider stages the new content only', async () => {
		await repository.write('tracked.txt', 'one\nSTAGED\nthree\n');
		await repository.git('add', 'tracked.txt');
		await repository.write('tracked.txt', 'one\nWORKING\nthree\n');

		await vscode.workspace.fs.writeFile(
			uriFor('tracked.txt'),
			Buffer.from('one\nEDITED\nthree\n', 'utf8'),
		);

		assert.equal(await repository.staged('tracked.txt'), 'one\nEDITED\nthree\n');
		assert.equal(await repository.read('tracked.txt'), 'one\nWORKING\nthree\n');
	});

	test('a saved document round-trips byte-for-byte when untouched', async () => {
		await repository.write('crlf.txt', 'a\r\nb\r\n');
		await repository.git('add', 'crlf.txt');

		const uri = uriFor('crlf.txt');
		const before = Buffer.from(await vscode.workspace.fs.readFile(uri));
		await vscode.workspace.fs.writeFile(uri, before);
		const after = Buffer.from(await vscode.workspace.fs.readFile(uri));

		assert.equal(after.toString('hex'), before.toString('hex'));
	});

	test('reading a path with no index entry fails rather than inventing content', async () => {
		await repository.git('rm', '-q', 'tracked.txt');
		await assert.rejects(async () => {
			await vscode.workspace.fs.stat(uriFor('tracked.txt'));
		});
	});

	test('a staged addition is readable and writable', async () => {
		await repository.write('added.txt', 'brand new\n');
		await repository.git('add', 'added.txt');

		const uri = uriFor('added.txt');
		assert.equal(
			Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'),
			'brand new\n',
		);

		await vscode.workspace.fs.writeFile(uri, Buffer.from('edited before the first commit\n'));
		assert.equal(await repository.staged('added.txt'), 'edited before the first commit\n');
	});

	test('a staged rename is editable at its new path', async () => {
		await repository.git('mv', 'tracked.txt', 'renamed.txt');

		// Small enough that git still scores the pair as a rename rather than an
		// add/delete — the case that matters, since that is what keeps the diff paired up.
		await vscode.workspace.fs.writeFile(
			uriFor('renamed.txt'),
			Buffer.from('one\ntwo\nthree\nfour\n', 'utf8'),
		);

		assert.equal(await repository.staged('renamed.txt'), 'one\ntwo\nthree\nfour\n');
		const status = await repository.git('diff', '--cached', '--name-status', '-M');
		assert.match(status, /^R\d*\s+tracked\.txt\s+renamed\.txt/m, 'still recorded as a rename');
	});
});

suite('editability', () => {
	let repository: TempRepository;

	setup(async () => {
		repository = await createTempRepository();
	});

	teardown(async () => {
		await repository.dispose();
	});

	function target(relativePath: string) {
		return { repositoryRoot: repository.root, relativePath };
	}

	test('a staged modification is editable', async () => {
		await repository.write('tracked.txt', 'changed\n');
		await repository.git('add', 'tracked.txt');

		const result = await checkEditability(target('tracked.txt'));
		assert.equal(result.editable, true);
	});

	test('a staged deletion is not', async () => {
		await repository.git('rm', '-q', 'tracked.txt');

		const result = await checkEditability(target('tracked.txt'));
		assert.equal(result.editable, false);
		assert.match((result as { reason: string }).reason, /deletion/);
	});

	test('binary content is not', async () => {
		await repository.write('binary.bin', 'head\u0000tail');
		await repository.git('add', 'binary.bin');

		const result = await checkEditability(target('binary.bin'));
		assert.equal(result.editable, false);
		assert.match((result as { reason: string }).reason, /binary/);
	});

	test('an unmerged path is not', async () => {
		await repository.git('checkout', '-q', '-b', 'other');
		await repository.write('tracked.txt', 'from other\n');
		await repository.git('commit', '-q', '-am', 'other side');
		await repository.git('checkout', '-q', 'main');
		await repository.write('tracked.txt', 'from main\n');
		await repository.git('commit', '-q', '-am', 'main side');
		await repository.git('merge', 'other').catch(() => undefined);

		const result = await checkEditability(target('tracked.txt'));
		assert.equal(result.editable, false);
		assert.match((result as { reason: string }).reason, /unmerged/);
	});
});
