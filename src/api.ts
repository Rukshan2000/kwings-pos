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

/// The backend recomputes the amount from `kind` and `value`; the client never
/// sends a money figure for a discount.
export type DiscountIn = { kind: "percent" | "fixed"; value: string };

export type SaleLineIn = {
  product_id: number;
  unit_id: number;
  quantity: string;
  unit_price: string;
  discount: DiscountIn | null;
};

export type PaymentIn = { method: string; amount: string };

export type CheckoutInput = {
  held_sale_id: number | null;
  customer_id: number | null;
  lines: SaleLineIn[];
  payments: PaymentIn[];
  bill_discount: DiscountIn | null;
};

export type SaleSummary = {
  id: number;
  invoice_number: string | null;
  subtotal: string;
  discount_total: string;
  grand_total: string;
  balance_due: string;
};

export type ReceiptLine = { name: string; qty: string; price: string; discount_amount: string };
export type ReceiptData = {
  invoice_number: string;
  completed_at: string;
  lines: ReceiptLine[];
  subtotal: string;
  discount_total: string;
  bill_discount: string;
  grand_total: string;
};

export type HeldSaleLine = {
  product_id: number;
  name: string;
  unit_id: number;
  quantity: string;
  unit_price: string;
  discount_kind: "percent" | "fixed" | null;
  discount_value: string | null;
};

export type HeldSaleDetail = {
  id: number;
  customer_id: number | null;
  lines: HeldSaleLine[];
  bill_discount: { kind: "percent" | "fixed"; value: string } | null;
};

export type Supplier = {
  id: number;
  name: string;
  phone: string | null;
  address: string | null;
  outstanding: string;
};

export type Purchase = {
  id: number;
  supplier_id: number;
  supplier_name: string;
  invoice_number: string | null;
  status: "draft" | "received" | "cancelled";
  total: string;
  paid: string;
  created_at: string;
};

export type PurchaseLine = {
  id: number;
  product_id: number;
  product_name: string;
  unit_id: number;
  unit_code: string;
  quantity: string;
  unit_cost: string;
  line_total: string;
};

export type PurchaseDetail = Purchase & { lines: PurchaseLine[] };

export type StockLevel = {
  product_id: number;
  product_name: string;
  sku: string | null;
  base_unit_code: string;
  on_hand: string;
  low_stock_at: string | null;
  cost_price: string;
};

export type StockMovement = {
  id: number;
  quantity: string;
  reason: string;
  unit_cost: string | null;
  note: string | null;
  created_at: string;
  created_by_name: string | null;
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

  stockLevels: (lowStockOnly: boolean) =>
    invoke<StockLevel[]>("stock_levels", { lowStockOnly }),
  stockMovements: (productId: number) =>
    invoke<StockMovement[]>("stock_movements", { productId }),
  stockValuation: () => invoke<string>("stock_valuation"),
  recordOpeningStock: (input: { product_id: number; quantity: string; unit_cost: string }) =>
    invoke<void>("record_opening_stock", { input }),
  adjustStock: (input: { product_id: number; quantity: string; reason_note: string }) =>
    invoke<void>("adjust_stock", { input }),

  suppliers: () => invoke<Supplier[]>("list_suppliers"),
  createSupplier: (input: { name: string; phone: string | null; address: string | null }) =>
    invoke<Supplier>("create_supplier", { input }),

  purchases: () => invoke<Purchase[]>("list_purchases"),
  purchase: (id: number) => invoke<PurchaseDetail>("get_purchase", { id }),
  createPurchase: (input: {
    supplier_id: number;
    invoice_number: string | null;
    lines: { product_id: number; unit_id: number; quantity: string; unit_cost: string }[];
  }) => invoke<PurchaseDetail>("create_purchase", { input }),
  receivePurchase: (id: number) => invoke<PurchaseDetail>("receive_purchase", { id }),
  recordPurchasePayment: (purchaseId: number, amount: string, method: string) =>
    invoke<void>("record_purchase_payment", { purchaseId, amount, method }),

  completeSale: (input: CheckoutInput) => invoke<SaleSummary>("complete_sale", { input }),
  holdSale: (
    customerId: number | null,
    lines: SaleLineIn[],
    billDiscount: DiscountIn | null,
    heldSaleId: number | null
  ) => invoke<number>("hold_sale", { customerId, lines, billDiscount, heldSaleId }),
  listHeldSales: () =>
    invoke<{ id: number; created_at: string; customer_id: number | null; customer_name: string | null; line_count: number; subtotal: string }[]>(
      "list_held_sales"
    ),
  heldSale: (id: number) => invoke<HeldSaleDetail>("held_sale", { id }),
  cancelHeldSale: (id: number) => invoke<void>("cancel_held_sale", { id }),
  saleReceipt: (saleId: number) => invoke<ReceiptData>("sale_receipt", { saleId }),
};
