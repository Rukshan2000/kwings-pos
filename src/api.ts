import { invoke } from "@tauri-apps/api/core";

// Thin typed wrapper over Tauri commands. All SQL and business logic live in
// src-tauri/src/catalogue — this file only shapes the request/response types.

export type Category = { id: number; name: string };
export type Brand = { id: number; name: string };
export type Unit = { id: number; code: string; name: string };

export type Product = {
  id: number;
  sku: string | null;
  barcode: string | null;
  name: string;
  category_id: number | null;
  category_name: string | null;
  brand_id: number | null;
  brand_name: string | null;
  base_unit_id: number;
  base_unit_code: string;
  cost_price: string;
  selling_price: string;
  low_stock_at: string | null;
  active: boolean;
};

export type ProductUnit = {
  id: number;
  unit_id: number;
  unit_code: string;
  factor: string;
  barcode: string | null;
};

export type PriceTier = {
  id: number;
  unit_id: number;
  unit_code: string;
  kind: "retail" | "wholesale";
  min_qty: string;
  price: string;
};

export type ProductDetail = Product & {
  units: ProductUnit[];
  price_tiers: PriceTier[];
};

export type ProductInput = {
  sku: string | null;
  barcode: string | null;
  name: string;
  category_id: number | null;
  brand_id: number | null;
  base_unit_id: number;
  cost_price: string;
  selling_price: string;
  low_stock_at: string | null;
};

export const api = {
  categories: () => invoke<Category[]>("list_categories"),
  createCategory: (name: string) => invoke<Category>("create_category", { name }),

  brands: () => invoke<Brand[]>("list_brands"),
  createBrand: (name: string) => invoke<Brand>("create_brand", { name }),

  units: () => invoke<Unit[]>("list_units"),

  products: (search?: string) => invoke<Product[]>("list_products", { search }),
  product: (id: number) => invoke<ProductDetail>("get_product", { id }),
  createProduct: (input: ProductInput) => invoke<Product>("create_product", { input }),
  updateProduct: (id: number, input: ProductInput) =>
    invoke<Product>("update_product", { id, input }),
  archiveProduct: (id: number) => invoke<void>("archive_product", { id }),

  setProductUnit: (
    productId: number,
    input: { unit_id: number; factor: string; barcode: string | null }
  ) => invoke<ProductUnit[]>("set_product_unit", { productId, input }),

  setPriceTier: (
    productId: number,
    input: { unit_id: number; kind: string; min_qty: string; price: string }
  ) => invoke<PriceTier[]>("set_price_tier", { productId, input }),
};
