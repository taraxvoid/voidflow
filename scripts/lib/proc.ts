/**
 * Child processes for the fleet tools, on node:child_process so the CLI runs
 * under Node as well as Bun.
 */
import { spawn } from 'node:child_process'

/**
 * Run `cmd`, feeding it `stdin` when given, and resolve with its exit code and
 * captured output. Rejects only when the command can't be started (e.g. not
 * on PATH); a non-zero exit is the caller's to judge.
 */
export function capture(
    cmd: string[],
    stdin?: string,
): Promise<{ code: number; out: string; err: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd[0], cmd.slice(1), {
            stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        })
        const out: Buffer[] = []
        const err: Buffer[] = []
        child.stdout.on('data', (b: Buffer) => out.push(b))
        child.stderr.on('data', (b: Buffer) => err.push(b))
        child.on('error', reject)
        child.on('close', (code, signal) =>
            resolve({
                code: code ?? (signal ? 128 : 1),
                out: Buffer.concat(out).toString('utf8'),
                err: Buffer.concat(err).toString('utf8'),
            }),
        )
        if (stdin !== undefined) child.stdin?.end(stdin)
    })
}

/**
 * Run `cmd` attached to this terminal and resolve with its exit code. A
 * command that can't be started resolves 127, as a shell would.
 */
export function inherit(
    cmd: string[],
    opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<number> {
    return new Promise((resolve) => {
        const child = spawn(cmd[0], cmd.slice(1), { ...opts, stdio: 'inherit' })
        child.on('error', (e) => {
            console.error(`${cmd[0]}: ${e.message}`)
            resolve(127)
        })
        child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)))
    })
}
