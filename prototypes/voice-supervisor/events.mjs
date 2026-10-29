/** Labels are laboratory assertions, not a production task-completion protocol. */
export function answerPhase(text) {
  const start = text.trim().replace(/^\*+/, '');
  if (start.startsWith('【结果】')) return 'final';
  if (start.startsWith('【进度】')) return 'progress';
  return 'initial';
}
