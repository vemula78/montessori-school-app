// Display words for the annual Progress Report (screens may not import src/domain beyond dates/money; a test checks
// these against src/domain/evaluation-rubrics.js).
export const LEVEL_LABEL = { toddlers: 'Toddlers', mont1: 'Mont 1', mont2: 'Mont 2', mont3: 'Mont 3' };
export const LEVEL_OPTIONS = Object.entries(LEVEL_LABEL).map(([value, label]) => ({ value, label }));
export const RATING_LABEL = { progressing: 'Progressing', mastered: 'Mastered', developing: 'Developing', developed: 'Developed' };
export const EVAL_STATUS = {
  not_started: ['Not started', 'mute'],
  draft: ['Draft', 'clay'],
  submitted: ['Submitted', 'warn'],
  published: ['Published', 'ok'],
};
/** "2025-26" from an academic year's label "AY 2025-26" (the form's header and the screens). */
export const yearText = (ay) => String(ay?.label || ay?.id || '').replace(/^AY\s*/i, '');
