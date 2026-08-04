/**
 * Cross-platform launcher for the GenOffice shell dev process.
 *
 * The root `dev` script shells out to the Electron shell with the four renderer
 * URLs as environment variables. The old inline form (`A=1 B=2 npm ...`) only
 * works in POSIX shells and breaks on Windows cmd/PowerShell. This wrapper sets
 * the variables in `process.env` (so the child inherits them) and then runs the
 * shell's own dev command — identically on every platform, no extra deps.
 */
import { spawn } from 'node:child_process'

const env = {
  ...process.env,
  DOCS_RENDERER_URL: process.env.DOCS_RENDERER_URL || 'http://localhost:5173',
  SHEETS_RENDERER_URL: process.env.SHEETS_RENDERER_URL || 'http://localhost:5174',
  SLIDES_RENDERER_URL: process.env.SLIDES_RENDERER_URL || 'http://localhost:5175',
  PDF_RENDERER_URL: process.env.PDF_RENDERER_URL || 'http://localhost:5176',
}

const SHELL_CMD = 'npm run dev -w @genoffice/shell'

// On Windows, npm is a .cmd shim that can only run through the shell, and
// spawning it must go through cmd.exe without the fragile `shell:true` + args
// concatenation (which breaks on paths containing spaces). On POSIX we spawn
// the npm binary directly.
const child =
  process.platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/s', '/c', SHELL_CMD], { stdio: 'inherit', env })
    : spawn('npm', ['run', 'dev', '-w', '@genoffice/shell'], { stdio: 'inherit', env })

const forward = (signal) => () => child.kill(signal)
process.on('SIGINT', forward('SIGINT'))
process.on('SIGTERM', forward('SIGTERM'))

child.on('error', (err) => {
  console.error('Failed to launch the GenOffice shell dev process:', err)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
