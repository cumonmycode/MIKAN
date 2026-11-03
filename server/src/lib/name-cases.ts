/**
 * Russian first names in the genitive («У Фатимы перерыв»). The employee's gender is not stored, so only endings
 * that decline the same way for everyone are handled; anything else (several words, «-ь», Latin letters) → null and
 * the caller words the sentence without declining.
 */

const HUSHING_OR_VELAR = 'гкхжчшщ';
const INDECLINABLE_ENDINGS = 'оеиуюэы';
const CONSONANTS = 'бвгджзклмнпрстфхцчшщ';

export function genitiveName(name: string): string | null {
  const word = name.trim();
  if (!/^[А-ЯЁ][а-яё-]+$/.test(word)) return null;
  const last = word.at(-1)!;
  const stem = word.slice(0, -1);
  if (last === 'а') return stem + (HUSHING_OR_VELAR.includes(stem.at(-1)!) ? 'и' : 'ы');
  if (last === 'я') return `${stem}и`;
  if (last === 'й') return `${stem}я`;
  if (INDECLINABLE_ENDINGS.includes(last)) return word;
  if (CONSONANTS.includes(last)) return `${word}а`;
  return null;
}
