// Publishes the built site (app/dist) to the gh-pages branch, which GitHub Pages serves.
// Run with `npm run deploy` from app/ (it builds first).
//
// The branch only ever holds generated files, so each deploy replaces it with a single
// fresh commit (a force push) instead of piling up copies of the 27 MB data file.
import { execSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(appDir, 'dist')
const git = (args, cwd) => execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim()

if (!existsSync(path.join(dist, 'index.html'))) {
  console.error('No build found in app/dist. Run "npm run build" first.')
  process.exit(1)
}

// Reuse this repository's remote and commit identity
const remote = git('remote get-url origin', appDir)
const name = git('config user.name', appDir)
const email = git('config user.email', appDir)
const source = git('rev-parse --short HEAD', appDir)

writeFileSync(path.join(dist, '.nojekyll'), '') // serve the files as they are, no Jekyll pass
const scratchRepo = path.join(dist, '.git')
rmSync(scratchRepo, { recursive: true, force: true })
try {
  // `git init -b` needs Git 2.28+, so name the branch in a separate step
  git('init -q', dist)
  git('symbolic-ref HEAD refs/heads/gh-pages', dist)
  git('add -A', dist)
  git(`-c user.name="${name}" -c user.email="${email}" commit -q -m "Deploy ${source}"`, dist)
  execSync(`git push -f "${remote}" gh-pages`, { cwd: dist, stdio: 'inherit' })
  console.log('Published. GitHub Pages usually updates within a minute or two.')
} finally {
  rmSync(scratchRepo, { recursive: true, force: true })
}
