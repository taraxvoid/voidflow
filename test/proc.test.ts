import { describe, expect, test } from 'bun:test'
import { capture, inherit } from '../scripts/lib/proc.ts'

describe('capture', () => {
    test('returns stdout, stderr and the exit code', async () => {
        const r = await capture(['sh', '-c', 'echo out; echo err >&2; exit 3'])
        expect(r).toEqual({ code: 3, out: 'out\n', err: 'err\n' })
    })

    test('feeds stdin when given', async () => {
        expect((await capture(['cat'], '{"a":1}')).out).toBe('{"a":1}')
    })

    test('stdin is closed when not given, so a reader gets EOF', async () => {
        expect(await capture(['cat'])).toEqual({ code: 0, out: '', err: '' })
    })

    test('rejects when the command cannot start', async () => {
        await expect(capture(['voidflow-no-such-command'])).rejects.toThrow()
    })
})

describe('inherit', () => {
    test('resolves with the exit code, in cwd, with env', async () => {
        const code = await inherit(
            ['sh', '-c', 'test "$PWD" = /tmp && test "$X" = y && exit 4'],
            {
                cwd: '/tmp',
                env: { PATH: process.env.PATH, X: 'y' },
            },
        )
        expect(code).toBe(4)
    })

    test('resolves 127 when the command cannot start', async () => {
        expect(await inherit(['voidflow-no-such-command'])).toBe(127)
    })
})
