import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { nodeExec } from '../adapters/exec'
import { nodeFs } from '../adapters/fs'
import type { OrcaCli } from '../adapters/orca-cli'
import { parseSettings } from '../core/settings'
import { createHubService } from './hub-service'
import { createWorkerDefaultsService } from './worker-defaults-service'

for (const target of ['project', 'directory', 'file', 'dangling', 'outside']) {
  for (const service of ['defaults', 'board']) {
    test(`${service} refuses a symlink at ${target} without changing its destination`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'unifier-write-'))
      const projects = join(root, 'projects')
      const project = join(projects, 'demo')
      const excluded = join(projects, 'Beta')
      const filename =
        service === 'defaults' ? 'worker-defaults.json' : 'board.unifier-board'
      await mkdir(excluded, { recursive: true })
      const destination = join(excluded, filename)
      await writeFile(destination, 'untouched')
      if (target === 'project' || target === 'outside') {
        const folder = target === 'outside' ? join(root, 'elsewhere') : excluded
        await mkdir(folder, { recursive: true })
        await symlink(folder, project)
      } else {
        await mkdir(project)
        if (target === 'directory')
          await symlink(excluded, join(project, '.unifier'))
        else {
          await mkdir(join(project, '.unifier'))
          await symlink(
            target === 'dangling' ? join(excluded, 'missing') : destination,
            join(project, '.unifier', filename),
          )
        }
      }
      const host = mockHost()
      const worker = await mountWorker(
        {
          default(orca) {
            const settings = async () =>
              parseSettings(
                { excludedProjects: 'alpha,beta', projectsRoot: projects },
                root,
              )
            createWorkerDefaultsService(orca, {
              settings,
              fs: nodeFs,
              exec: nodeExec,
              home: root,
            })
            createHubService(
              orca,
              {
                async ensureFolderWorkspace() {
                  return 'hub'
                },
              } as unknown as OrcaCli,
              settings,
              nodeFs,
            )
          },
        },
        { host },
      )
      try {
        const result =
          service === 'defaults'
            ? await worker.request('workerDefaults.set', {
                project: 'demo',
                kind: 'review',
                agent: 'codex',
                model: 'gpt-6.1-sol',
              })
            : await worker.request('hub.open', {
                scope: 'project',
                project: 'demo',
              })
        assert.ok('error' in result)
        assert.equal(await readFile(destination, 'utf8'), 'untouched')
        assert.equal(await nodeFs.exists(join(excluded, 'missing')), false)
        if (service === 'board')
          assert.equal(host.callsOf('workspace.open').length, 0)
      } finally {
        await worker.deactivate()
        await rm(root, { recursive: true, force: true })
      }
    })
  }
}

for (const service of ['defaults', 'board']) {
  for (const broken of [false, true]) {
    test(`${service} ${broken ? 'refuses an unresolved gitfile' : 'excludes metadata in the git common directory'}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'unifier-gitfile-'))
      const main = join(root, 'main')
      const project = join(root, 'demo')
      await mkdir(main)
      assert.equal((await nodeExec('git', ['init', main])).code, 0)
      assert.equal(
        (
          await nodeExec('git', [
            '-C',
            main,
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '--allow-empty',
            '-m',
            'initial',
          ])
        ).code,
        0,
      )
      assert.equal(
        (
          await nodeExec('git', [
            '-C',
            main,
            'worktree',
            'add',
            '-b',
            'demo',
            project,
          ])
        ).code,
        0,
      )
      if (broken)
        await writeFile(
          join(project, '.git'),
          'gitdir: /missing/unifier-test\n',
        )
      const host = mockHost({
        results: {
          'workspace.open': { opened: true },
          'editor.open': { opened: true },
        },
      })
      const worker = await mountWorker(
        {
          default(orca) {
            const settings = async () =>
              parseSettings(
                { excludedProjects: 'alpha,beta', projectsRoot: root },
                root,
              )
            createWorkerDefaultsService(orca, {
              settings,
              fs: nodeFs,
              exec: nodeExec,
              home: root,
            })
            createHubService(
              orca,
              {
                async ensureFolderWorkspace() {
                  return 'hub'
                },
              } as unknown as OrcaCli,
              settings,
              nodeFs,
            )
          },
        },
        { host },
      )
      try {
        const result =
          service === 'defaults'
            ? await worker.request('workerDefaults.set', {
                project: 'demo',
                kind: 'review',
                agent: 'codex',
                model: 'gpt-6.1-sol',
              })
            : await worker.request('hub.open', {
                scope: 'project',
                project: 'demo',
              })
        if (broken) {
          assert.ok('error' in result)
          assert.equal(await nodeFs.exists(join(project, '.unifier')), false)
        } else {
          assert.deepEqual(result, { ok: true })
          assert.ok(
            (await readFile(join(main, '.git/info/exclude'), 'utf8')).includes(
              '.unifier/\n',
            ),
          )
          assert.equal(
            (await nodeExec('git', ['-C', project, 'status', '--porcelain']))
              .stdout,
            '',
          )
        }
      } finally {
        await worker.deactivate()
        await rm(root, { recursive: true, force: true })
      }
    })
  }
}

for (const service of ['defaults', 'board']) {
  for (const excluded of ['Beta', 'ALPHA']) {
    test(`${service} never updates an excluded Project through a git common directory: ${excluded}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'unifier-excluded-common-'))
      const main = join(root, excluded)
      const project = join(root, 'demo')
      await mkdir(main)
      assert.equal((await nodeExec('git', ['init', main])).code, 0)
      assert.equal(
        (
          await nodeExec('git', [
            '-C',
            main,
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '--allow-empty',
            '-m',
            'initial',
          ])
        ).code,
        0,
      )
      assert.equal(
        (
          await nodeExec('git', [
            '-C',
            main,
            'worktree',
            'add',
            '-b',
            'demo',
            project,
          ])
        ).code,
        0,
      )
      const exclude = join(main, '.git/info/exclude')
      const before = await readFile(exclude, 'utf8')
      const host = mockHost({
        results: {
          'workspace.open': { opened: true },
          'editor.open': { opened: true },
        },
      })
      const worker = await mountWorker(
        {
          default(orca) {
            const settings = async () =>
              parseSettings(
                { excludedProjects: 'alpha,beta', projectsRoot: root },
                root,
              )
            createWorkerDefaultsService(orca, {
              settings,
              fs: nodeFs,
              exec: nodeExec,
              home: root,
            })
            createHubService(
              orca,
              {
                async ensureFolderWorkspace() {
                  return 'hub'
                },
              } as unknown as OrcaCli,
              settings,
              nodeFs,
            )
          },
        },
        { host },
      )
      try {
        const result =
          service === 'defaults'
            ? await worker.request('workerDefaults.set', {
                project: 'demo',
                kind: 'review',
                agent: 'codex',
                model: 'gpt-6.1-sol',
              })
            : await worker.request('hub.open', {
                scope: 'project',
                project: 'demo',
              })
        assert.ok('error' in result)
        assert.equal(await readFile(exclude, 'utf8'), before)
        assert.equal(await nodeFs.exists(join(project, '.unifier')), false)
      } finally {
        await worker.deactivate()
        await rm(root, { recursive: true, force: true })
      }
    })
  }
}
