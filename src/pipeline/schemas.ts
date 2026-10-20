import type { Schema } from '../agents/json.ts';

const str: Schema = { type: 'string' };
const strArr: Schema = { type: 'array', items: { type: 'string' } };

export const PLAN_SCHEMA: Schema = {
  type: 'object',
  required: ['summary', 'blocked', 'assumptions', 'currentState', 'expectedState', 'acceptanceCriteria', 'filesToChange', 'steps', 'testing', 'risks', 'coverage', 'complexity'],
  properties: {
    summary: { ...str, description: 'two or three sentences' },
    blocked: {
      type: 'object',
      required: ['is', 'questions'],
      properties: { is: { type: 'boolean' }, questions: strArr },
    },
    assumptions: strArr,
    currentState: { ...str, description: 'how the relevant code works today, citing files/symbols' },
    expectedState: { ...str, description: 'the desired behaviour and what must not change' },
    acceptanceCriteria: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'text', 'verification'],
        properties: { id: { ...str, description: 'AC1, AC2, …' }, text: str, verification: str },
      },
    },
    filesToChange: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'action', 'change', 'reason'],
        properties: {
          path: str,
          action: { type: 'string', enum: ['create', 'modify', 'delete', 'rename'] },
          change: str,
          reason: str,
        },
      },
    },
    steps: { ...strArr, description: 'ordered implementation steps' },
    testing: {
      type: 'object',
      required: ['commands', 'cases'],
      properties: { commands: strArr, cases: strArr },
    },
    risks: strArr,
    coverage: {
      type: 'array',
      items: {
        type: 'object',
        required: ['requirement', 'change', 'verification'],
        properties: { requirement: str, change: str, verification: str },
      },
    },
    complexity: { type: 'string', enum: ['S', 'M', 'L'] },
    deliverable: { type: 'string', enum: ['code', 'answer'], description: "'answer' when the task is a question/analysis that needs no code change" },
    answer: { ...str, description: 'REQUIRED when deliverable is "answer": the complete answer in markdown, citing files' },
  },
};

export const PLAN_REVIEW_SCHEMA: Schema = {
  type: 'object',
  required: ['decision', 'summary', 'issues'],
  properties: {
    decision: { type: 'string', enum: ['approved', 'changes_requested'] },
    summary: str,
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'text'],
        properties: { severity: { type: 'string', enum: ['blocking', 'suggestion'] }, text: str },
      },
    },
  },
};

export const VERDICT_SCHEMA: Schema = {
  type: 'object',
  required: ['verdict', 'summary', 'acceptance', 'bugs'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    summary: str,
    acceptance: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'status', 'evidence'],
        properties: { id: str, status: { type: 'string', enum: ['met', 'not_met', 'unverifiable'] }, evidence: str },
      },
    },
    bugs: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        required: ['title', 'severity', 'evidence'],
        properties: {
          title: str,
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          file: str,
          line: { type: 'integer' },
          evidence: str,
          repro: str,
          suggestedFix: str,
        },
      },
    },
  },
};
