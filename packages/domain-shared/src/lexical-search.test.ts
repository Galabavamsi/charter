import { describe, expect, it } from 'vitest';
import {
  isLexicalSmallTalk,
  lexicalOverlapScore,
  lexicalPhrase,
  lexicalSearchTokens,
} from './lexical-search.js';

describe('lexical search tokens', () => {
  it('keeps content words and drops short or function scaffolding', () => {
    expect(lexicalSearchTokens('find me a shop to gift coffee')).toEqual(['gift', 'coffee']);
    expect(lexicalPhrase('find a coffee shop')).toBe('coffee');
    expect(lexicalSearchTokens('cheapest coffee for a trek')).toEqual([
      'cheapest',
      'coffee',
      'trek',
    ]);
  });

  it('expands gift and apparel intent so short words still search', () => {
    expect(lexicalSearchTokens('i want to buy a tshirt for gf')).toEqual(
      expect.arrayContaining(['tshirt', 'tee', 'shirt', 'gift']),
    );
    expect(lexicalPhrase('how about a notebook')).toBe('notebook');
  });

  it('treats greetings as small talk', () => {
    expect(isLexicalSmallTalk('hi')).toBe(true);
    expect(isLexicalSmallTalk('ok')).toBe(true);
    expect(isLexicalSmallTalk('find me a shop')).toBe(true);
    expect(isLexicalSmallTalk('gift coffee')).toBe(false);
  });

  it('scores partial token overlap instead of requiring every token in one field', () => {
    expect(lexicalOverlapScore('Northstar Travel Coffee', 'gift coffee', 40)).toBeGreaterThan(0);
    expect(lexicalOverlapScore('pour-over coffee', 'gift coffee', 30)).toBeGreaterThan(0);
    expect(lexicalOverlapScore('Ruled notebook, A5', 'gift coffee', 30)).toBe(0);
  });

  it('matches subjective typos against live catalog words without product aliases', () => {
    expect(
      lexicalOverlapScore('Unopened stationery within 7 days of capture.', 'stationaery', 18),
    ).toBeGreaterThan(0);
    expect(
      lexicalOverlapScore('Notebooks, pens, and stationery.', 'stationery', 18),
    ).toBeGreaterThan(0);
    expect(lexicalOverlapScore('pour-over coffee', 'coffin', 30)).toBe(0);
  });
});
