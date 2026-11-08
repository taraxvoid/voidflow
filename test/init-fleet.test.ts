import { describe, expect, test } from 'bun:test'
import { addToFleet } from '../scripts/init/fleet.ts'

const added = (text: string, repo = 'taraxvoid/new') => {
    const r = addToFleet(text, repo)
    if (r.status !== 'added')
        throw new Error(`expected added: ${JSON.stringify(r)}`)
    return r.text
}

const ORGS = `// fleet
export default {
    orgs: {
        taraxvoid: {
            // the main org
            repos: {
                voidflow: { tiers: ['x'] }, // }
                'txv.sh': {},
            },
        },
        queeromaha: { repos: { 'queeromaha.net': {} } },
    },
}
`

describe('addToFleet with orgs', () => {
    test("adds into an existing owner's repos, matching its indent", () => {
        expect(added(ORGS)).toBe(
            ORGS.replace(
                "                'txv.sh': {},\n",
                "                'txv.sh': {},\n                'new': {},\n",
            ),
        )
    })

    test('adds a missing comma after the last entry', () => {
        const text =
            'export default {\n  orgs: {\n    o: {\n      repos: {\n        a: {}\n      },\n    },\n  },\n}\n'
        expect(added(text, 'o/b')).toBe(
            "export default {\n  orgs: {\n    o: {\n      repos: {\n        a: {},\n        'b': {},\n      },\n    },\n  },\n}\n",
        )
    })

    test('an empty repos block takes the repos key indent plus 4', () => {
        const text =
            'export default {\n    orgs: {\n        o: {\n            repos: {},\n        },\n    },\n}\n'
        expect(added(text, 'o/b')).toBe(
            "export default {\n    orgs: {\n        o: {\n            repos: {\n                'b': {},\n            },\n        },\n    },\n}\n",
        )
    })

    test('a name already there, quoted or not, is unchanged', () => {
        expect(addToFleet(ORGS, 'taraxvoid/voidflow').status).toBe('unchanged')
        expect(addToFleet(ORGS, 'taraxvoid/txv.sh').status).toBe('unchanged')
        expect(addToFleet(ORGS, 'queeromaha/queeromaha.net').status).toBe(
            'unchanged',
        )
    })

    test('a new owner is appended to orgs', () => {
        expect(added(ORGS, 'neworg/site')).toBe(
            ORGS.replace(
                "        queeromaha: { repos: { 'queeromaha.net': {} } },\n",
                "        queeromaha: { repos: { 'queeromaha.net': {} } },\n        neworg: { repos: { 'site': {} } },\n",
            ),
        )
        expect(added(ORGS, 'my-org/site')).toContain(
            "        'my-org': { repos: { 'site': {} } },\n    },\n}",
        )
    })

    test('owner and repo names match case-insensitively', () => {
        expect(addToFleet(ORGS, 'TaraXVoid/VoidFlow').status).toBe('unchanged')
        expect(added(ORGS, 'TaraXVoid/new')).toBe(
            ORGS.replace(
                "                'txv.sh': {},\n",
                "                'txv.sh': {},\n                'new': {},\n",
            ),
        )
    })

    test('orgs written as a shorthand fails, not a legacy append', () => {
        const r = addToFleet(
            'const orgs = { o: { repos: {} } }\nexport default { orgs }\n',
            'o/n',
        )
        expect(r.status).toBe('failed')
        if (r.status === 'failed')
            expect(r.detail).toContain('not written as an object literal')
    })

    test('an owner with no repos object fails', () => {
        const r = addToFleet(
            'export default { orgs: { o: { other: 1 } } }\n',
            'o/b',
        )
        expect(r.status).toBe('failed')
        if (r.status === 'failed') expect(r.detail).toContain('orgs.o')
    })

    test('a legacy flat file behaves as before', () => {
        expect(added("export const REPOS = {\n    'a/b': {}\n}\n", 'o/r')).toBe(
            "export const REPOS = {\n    'a/b': {},\n    'o/r': {},\n}\n",
        )
        expect(added("export default {\n    'o/orgs': {},\n}\n", 'o/r')).toBe(
            "export default {\n    'o/orgs': {},\n    'o/r': {},\n}\n",
        )
        expect(addToFleet("export default { 'A/B': {} }\n", 'a/b').status).toBe(
            'unchanged',
        )
    })

    test('a legacy file keeps its own indent', () => {
        expect(added("export default {\n  'a/b': {},\n}\n", 'o/r')).toBe(
            "export default {\n  'a/b': {},\n  'o/r': {},\n}\n",
        )
    })
})
