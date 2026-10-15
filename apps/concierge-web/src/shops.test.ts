// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  conciergeShopQuery,
  directoryShopSearchPath,
  isLexicalSmallTalk,
  publicCatalogSearch,
  shopFilters,
} from './shops';

describe('concierge shop directory query', () => {
  it('sends content tokens only — no category alias map', () => {
    expect(conciergeShopQuery('find a coffee shop')).toEqual({ q: 'coffee' });
    expect(directoryShopSearchPath('find a coffee shop')).toBe(
      '/v1/shops?sort=rating&limit=8&q=coffee',
    );
    expect(directoryShopSearchPath('find me a shop to gift coffee')).toBe(
      '/v1/shops?sort=rating&limit=8&q=gift+coffee',
    );
    expect(directoryShopSearchPath('find me a shop to gift coffee')).not.toContain('category=');
  });

  it('does not treat a greeting as a shop query', () => {
    expect(isLexicalSmallTalk('hi')).toBe(true);
    expect(conciergeShopQuery('hi')).toEqual({ q: '' });
    expect(directoryShopSearchPath('hi')).toBe('/v1/shops?sort=rating&limit=8');
  });
});

describe('public catalog search params', () => {
  it('asks for relevance explicitly when searching, since the directory defaults to rating', () => {
    expect(publicCatalogSearch(shopFilters(new URLSearchParams('q=coffee'))).toString()).toBe(
      'q=coffee&sort=relevance',
    );
    expect(publicCatalogSearch(shopFilters(new URLSearchParams())).toString()).toBe('');
    expect(publicCatalogSearch(shopFilters(new URLSearchParams('sort=name'))).toString()).toBe(
      'sort=name',
    );
  });
});
