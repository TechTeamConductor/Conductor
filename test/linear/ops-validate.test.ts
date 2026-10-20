/**
 * linear-ops-validate: EVERY document exported from src/linear/ops.ts must validate against the vendored
 * official Linear SDL with zero errors, and the variable builders must produce values the schema accepts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSchema, parse, validate, getVariableValues, Kind, visit } from 'graphql';
import type { OperationDefinitionNode } from 'graphql';
import * as ops from '../../src/linear/ops.ts';

const SDL_PATH = fileURLToPath(new URL('../fixtures/linear-schema.graphql', import.meta.url));
const schema = buildSchema(readFileSync(SDL_PATH, 'utf8'), { assumeValidSDL: true });

const documents = Object.entries(ops).filter(([, v]) => typeof v === 'string') as [string, string][];

function operation(doc: string): OperationDefinitionNode {
  const ast = parse(doc);
  const defs = ast.definitions.filter((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION);
  assert.equal(defs.length, 1, 'exactly one operation per document');
  return defs[0]!;
}

function coerce(doc: string, variables: Record<string, unknown>) {
  return getVariableValues(schema, operation(doc).variableDefinitions ?? [], variables);
}

describe('linear-ops-validate', () => {
  test('the vendored schema is the real Linear SDL', () => {
    assert.ok(schema.getType('IssueHistory'), 'IssueHistory');
    assert.ok(schema.getType('IssueFilter'), 'IssueFilter');
    assert.ok(schema.getType('WorkflowStateCreateInput'), 'WorkflowStateCreateInput');
    assert.ok(schema.getType('IssueLabelCreateInput'), 'IssueLabelCreateInput');
    assert.ok(schema.getType('CommentCreateInput'), 'CommentCreateInput');
  });

  test('the validator has teeth: an invalid selection is rejected', () => {
    assert.ok(validate(schema, parse('query { viewer { noSuchField } }')).length > 0);
    assert.ok(validate(schema, parse('query { issue(id: "x") { history { nodes { nope } } } }')).length > 0);
  });

  test('ops.ts exports a meaningful set of documents', () => {
    const names = documents.map(([n]) => n);
    for (const required of [
      'Q_VIEWER',
      'Q_TEAMS',
      'Q_TEAM_STATES',
      'Q_TEAM_LABELS',
      'Q_CANDIDATES',
      'Q_ISSUE',
      'Q_ISSUE_COMMENTS_PAGE',
      'Q_ISSUE_HISTORY_PAGE',
      'Q_ISSUE_CHILDREN',
      'M_ISSUE_UPDATE',
      'M_COMMENT_CREATE',
      'M_ISSUE_CREATE',
      'M_WORKFLOW_STATE_CREATE',
      'M_ISSUE_LABEL_CREATE',
    ]) {
      assert.ok(names.includes(required), `missing document ${required}`);
    }
  });

  for (const [name, doc] of documents) {
    test(`${name} validates against the official schema`, () => {
      const errors = validate(schema, parse(doc));
      assert.deepEqual(
        errors.map((e) => e.message),
        [],
      );
    });

    test(`${name}: declared variables == used variables`, () => {
      const op = operation(doc);
      const declared = new Set((op.variableDefinitions ?? []).map((v) => v.variable.name.value));
      const used = new Set<string>();
      visit(op, {
        Variable(node, _key, parent) {
          // skip the declaration itself (VariableDefinition.variable)
          if (parent && !Array.isArray(parent) && (parent as { kind?: string }).kind === Kind.VARIABLE_DEFINITION) return;
          used.add(node.name.value);
        },
      });
      assert.deepEqual([...used].sort(), [...declared].sort());
    });
  }

  test('mutations are mutations and queries are queries (by naming convention)', () => {
    for (const [name, doc] of documents) {
      const op = operation(doc);
      assert.equal(op.operation, name.startsWith('M_') ? 'mutation' : 'query', name);
    }
  });

  test('candidatesFilter coerces to IssueFilter (creator-only and includeAssigned forms)', () => {
    for (const includeAssigned of [false, true]) {
      const filter = ops.candidatesFilter('team-1', 'conductor', includeAssigned);
      const res = coerce(ops.Q_CANDIDATES, { filter });
      assert.equal('errors' in res && res.errors?.map((e) => e.message).join('; '), false, JSON.stringify(res));
    }
  });

  test('candidatesFilter: server-side creator scoping, label name, open states', () => {
    const base = ops.candidatesFilter('T', 'conductor');
    assert.deepEqual(base, {
      team: { id: { eq: 'T' } },
      labels: { some: { name: { eqIgnoreCase: 'conductor' } } },
      state: { type: { nin: ['completed', 'canceled'] } },
      creator: { isMe: { eq: true } },
    });
    const assigned = ops.candidatesFilter('T', 'conductor', true);
    assert.deepEqual(assigned.or, [{ creator: { isMe: { eq: true } } }, { assignee: { isMe: { eq: true } } }]);
    assert.equal('creator' in assigned, false, 'creator filter moves inside the or[] when includeAssigned');
  });

  test('teamLabelsFilter coerces to IssueLabelFilter', () => {
    const res = coerce(ops.Q_TEAM_LABELS, { filter: ops.teamLabelsFilter('team-1') });
    assert.ok(!('errors' in res && res.errors), JSON.stringify(res));
  });

  test('issueUpdateInput coerces to IssueUpdateInput and omits empty label arrays', () => {
    const input = ops.issueUpdateInput({ stateId: 's1', addLabelIds: ['a', 'a', 'b'], removeLabelIds: [], description: 'x' });
    assert.deepEqual(input, { stateId: 's1', addedLabelIds: ['a', 'b'], description: 'x' });
    const res = coerce(ops.M_ISSUE_UPDATE, { id: 'i1', input });
    assert.ok(!('errors' in res && res.errors), JSON.stringify(res));
    assert.deepEqual(ops.issueUpdateInput({}), {});
  });

  test('an unknown filter key would be rejected by the schema (the check has teeth)', () => {
    const res = coerce(ops.Q_CANDIDATES, { filter: { creatorIsMe: true } });
    assert.ok('errors' in res && res.errors && res.errors.length > 0);
  });

  test('create inputs (comment / issue / label / state) coerce, including client-supplied ids', () => {
    const cases: [string, Record<string, unknown>][] = [
      [ops.M_COMMENT_CREATE, { input: { id: '11111111-1111-4111-8111-111111111111', issueId: 'i', body: 'b' } }],
      [ops.M_ISSUE_CREATE, { input: { id: '11111111-1111-4111-8111-111111111111', teamId: 't', title: 'x', parentId: 'p', labelIds: ['l'], stateId: 's', projectId: 'pr', description: 'd' } }],
      [ops.M_ISSUE_LABEL_CREATE, { input: { id: '11111111-1111-4111-8111-111111111111', name: 'n', color: '#fff', teamId: 't' } }],
      [ops.M_WORKFLOW_STATE_CREATE, { input: { id: '11111111-1111-4111-8111-111111111111', name: 'n', color: '#fff', teamId: 't', type: 'started' } }],
    ];
    for (const [doc, vars] of cases) {
      const res = coerce(doc, vars);
      assert.ok(!('errors' in res && res.errors), JSON.stringify(res));
    }
  });
});
