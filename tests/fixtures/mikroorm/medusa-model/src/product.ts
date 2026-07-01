// Medusa v2 `model.define(...)` pattern (#383, #396).
// The framework's `model` helper exposes a fluent builder. Each
// property value is `model.<type>(...)` with optional .primaryKey() /
// .nullable() / .unique() / .searchable() / .index() modifiers.

type Mod = {
  primaryKey: () => Mod;
  nullable: () => Mod;
  unique: () => Mod;
  searchable: () => Mod;
  index: () => Mod;
};
const mod: Mod = {
  primaryKey: () => mod,
  nullable: () => mod,
  unique: () => mod,
  searchable: () => mod,
  index: () => mod,
};
const model = {
  define: (_name: string, _props: Record<string, unknown>) => ({} as unknown),
  id: (_opts?: { prefix?: string }) => mod,
  text: () => mod,
  number: () => mod,
  date: () => mod,
  json: () => mod,
  boolean: () => mod,
};

export const Product = model.define('product', {
  id: model.id({ prefix: 'prod' }).primaryKey(),    // primaryKey + type='id'
  title: model.text().searchable(),                 // type='text'
  price: model.number(),                            // type='number'
  description: model.text().nullable(),             // nullable + type='text'
  metadata: model.json().nullable(),                // nullable + type='json'
  created_at: model.date(),                         // type='date'
});

export const Variant = model.define('variant', {
  id: model.id().primaryKey(),                      // primaryKey + type='id'
  product_id: model.text().index(),                 // type='text' (index() ignored)
  sku: model.text().unique(),                       // type='text' (unique() ignored)
  in_stock: model.boolean(),                        // type='boolean'
});
