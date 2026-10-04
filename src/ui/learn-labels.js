// Shared wording for the learning screens: areas, progress statuses, terms. Display only.
export const AREA_KEYS = ['practicalLife', 'sensorial', 'language', 'math', 'culture'];
export const AREA_LABEL = { practicalLife: 'Practical life', sensorial: 'Sensorial', language: 'Language', math: 'Mathematics', culture: 'Culture' };
export const STATUS_KEYS = ['introduced', 'practising', 'mastered'];
export const STATUS_LABEL = { introduced: 'Introduced', practising: 'Practising', mastered: 'Mastered' };
export const STATUS_KIND = { introduced: 'info', practising: 'warn', mastered: 'ok' };
export const TERM_NAMES = ['Term 1', 'Term 2', 'Term 3'];
export const NARRATIVE_LABEL = { overall: 'Overall', ...AREA_LABEL };
export const REPORT_STATUS = { draft: ['Draft', 'mute'], submitted: ['Waiting for the principal', 'warn'], published: ['Published', 'ok'] };
