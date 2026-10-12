export interface NormalizedCatalogItem {
  sku: string;
  title: string;
  category: string;
  face_value: string;
  seagm_price_raw: { amount: number; currency: string };
  seagm_url: string;
  region_of_card: string;
  in_stock: boolean;
}

export interface CatalogSource {
  fetch(skus: string[]): Promise<NormalizedCatalogItem[] | null>;
}

// TODO(verify): SeaGM's ToS for crawling their pages is not yet confirmed in writing
// (resources_checklist.md, 17-DR-OPERATIONS.md §6) and there's no official reseller/API channel yet
// either — there is no real source to plug in here. Reporting "no source" explicitly (like
// noopIpRangeSource) rather than silently no-op-ing keeps that distinction visible in logs.
export const noopCatalogSource: CatalogSource = {
  fetch(): Promise<NormalizedCatalogItem[] | null> {
    return Promise.resolve(null);
  },
};
