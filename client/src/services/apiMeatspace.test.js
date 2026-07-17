import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./apiCore.js', () => ({
  request: vi.fn(),
}));

let request;
let updateGenomeMarkerNotes;
let addCustomDrink;
let updateCustomDrink;
let addCustomNicotineProduct;
let updateCustomNicotineProduct;

beforeEach(async () => {
  vi.resetModules();
  ({ request } = await import('./apiCore.js'));
  ({
    updateGenomeMarkerNotes,
    addCustomDrink,
    updateCustomDrink,
    addCustomNicotineProduct,
    updateCustomNicotineProduct,
  } = await import('./apiMeatspace.js'));
  request.mockReset();
  request.mockResolvedValue({});
});

// GenomeTab/NicotineTab/AlcoholTab all own their own failure toast (an inline
// `.catch` toast, or an `if (!result) toast.error(...)` after a swallowing
// catch). Without a way to suppress request()'s default toast, each failure
// reports twice — these wrappers must forward a trailing `options` (issue #2669).
describe('apiMeatspace double-toast wrappers forward options', () => {
  it('updateGenomeMarkerNotes forwards silent and keeps the PUT body', async () => {
    await updateGenomeMarkerNotes('m1', 'note text', { silent: true });
    const [path, options] = request.mock.calls[0];
    expect(path).toBe('/meatspace/genome/markers/m1/notes');
    expect(options.silent).toBe(true);
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({ notes: 'note text' });
  });

  it('addCustomDrink forwards silent and keeps the POST body', async () => {
    await addCustomDrink({ name: 'Lager', oz: 12, abv: 5 }, { silent: true });
    const [path, options] = request.mock.calls[0];
    expect(path).toBe('/meatspace/alcohol/custom-drinks');
    expect(options.silent).toBe(true);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ name: 'Lager', oz: 12, abv: 5 });
  });

  it('updateCustomDrink forwards silent and keeps the PUT body + indexed path', async () => {
    await updateCustomDrink(2, { name: 'IPA', oz: 16, abv: 7 }, { silent: true });
    const [path, options] = request.mock.calls[0];
    expect(path).toBe('/meatspace/alcohol/custom-drinks/2');
    expect(options.silent).toBe(true);
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({ name: 'IPA', oz: 16, abv: 7 });
  });

  it('addCustomNicotineProduct forwards silent and keeps the POST body', async () => {
    await addCustomNicotineProduct({ name: 'Pouch', mgPerUnit: 6 }, { silent: true });
    const [path, options] = request.mock.calls[0];
    expect(path).toBe('/meatspace/nicotine/custom-products');
    expect(options.silent).toBe(true);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ name: 'Pouch', mgPerUnit: 6 });
  });

  it('updateCustomNicotineProduct forwards silent and keeps the PUT body + indexed path', async () => {
    await updateCustomNicotineProduct(3, { name: 'Gum', mgPerUnit: 4 }, { silent: true });
    const [path, options] = request.mock.calls[0];
    expect(path).toBe('/meatspace/nicotine/custom-products/3');
    expect(options.silent).toBe(true);
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({ name: 'Gum', mgPerUnit: 4 });
  });

  it('stays callable without options (back-compat) and then toasts by default', async () => {
    await addCustomDrink({ name: 'Stout', oz: 12, abv: 6 });
    const [, options] = request.mock.calls[0];
    expect(options.silent).toBeUndefined();
    expect(options.method).toBe('POST');
  });
});
