export interface CatalogItem {
  readonly sku: string;
  readonly name: string;
  readonly available: boolean;
}
const catalog: Readonly<Record<string, CatalogItem>> = Object.freeze({
  "P-100": Object.freeze({ sku: "P-100", name: "Portable notebook", available: true }),
});
export function lookupCatalog(sku: string): CatalogItem | undefined {
  return catalog[sku];
}
