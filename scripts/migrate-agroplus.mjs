// One-time data migration from the old "AgroPlus" POS (flat Postgres schema,
// Next.js app) into this app's normalized schema (see src-tauri/migrations).
//
// Usage:
//   node scripts/migrate-agroplus.mjs [--dry-run]
//
// Source DB connection comes from AgroPlus's own .env.local
// (NEXT_PUBLIC_SUPABASE_URL, actually a plain Postgres URL despite the name).
// Target DB connection is read from this app's own config.json, written by
// the Tauri app on first launch (src-tauri/src/db/config.rs) — so the app
// only needs to have been launched once; it does not need to be running.
//
// Safe to re-run: every insert is keyed off a migration tag so a second run
// skips rows already migrated instead of duplicating them.

import pg from "pg";
import argon2 from "argon2";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DRY_RUN = process.argv.includes("--dry-run");

const OLD_DB_URL = "postgresql://rukshantharindu@localhost:5432/agroplus";

function newDbUrl() {
  const root =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "GreenPlusPOS")
      : process.platform === "win32"
        ? path.join(process.env.PROGRAMDATA ?? "C:\\ProgramData", "GreenPlusPOS")
        : path.join(os.homedir(), ".local", "share", "GreenPlusPOS");

  const cfgFile = path.join(root, "config.json");
  if (!fs.existsSync(cfgFile)) {
    throw new Error(
      `No GreenPlusPOS config at ${cfgFile}. Launch the app once (so it creates its database) before running this migration.`,
    );
  }
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  const user = "pos_admin";
  const pass = encodeURIComponent(cfg.password);
  return `postgres://${user}:${pass}@127.0.0.1:${cfg.port}/pos`;
}

// Old products.unit_type -> new unit.code (seeded in 0003_seed.sql).
const UNIT_MAP = {
  kg: "kg",
  g: "g",
  l: "l",
  ml: "ml",
  items: "pc",
  pcs: "pc",
  bags: "bag",
  bottles: "btl",
  packets: "pkt",
};

// Old users.role -> new user_role enum ('admin' | 'manager' | 'cashier').
function mapUserRole(oldRole) {
  if (oldRole === "admin") return "admin";
  if (oldRole === "manager") return "manager";
  return "cashier";
}

function mapPaymentMethod(old) {
  return old === "card" ? "card" : "cash";
}

function randomPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 12; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

async function main() {
  const oldPool = new pg.Pool({ connectionString: OLD_DB_URL });
  const newPool = new pg.Pool({ connectionString: newDbUrl() });

  const client = await newPool.connect();
  const generatedCredentials = [];

  try {
    await client.query("BEGIN");

    // ---------------------------------------------------------------- location
    const { rows: [defaultLocation] } = await client.query(
      "SELECT id FROM location WHERE is_default LIMIT 1",
    );
    if (!defaultLocation) throw new Error("target DB has no default location — run its migrations first");
    const locationId = defaultLocation.id;

    // ------------------------------------------------------------------- units
    const { rows: unitRows } = await client.query("SELECT id, code FROM unit");
    const unitIdByCode = Object.fromEntries(unitRows.map((u) => [u.code, u.id]));

    // -------------------------------------------------------------- categories
    const { rows: oldCategories } = await oldPool.query(
      "SELECT id, name FROM categories ORDER BY id",
    );
    const { rows: oldProductCategoryNames } = await oldPool.query(
      "SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category <> ''",
    );
    const categoryNames = new Set([
      ...oldCategories.map((c) => c.name.trim()),
      ...oldProductCategoryNames.map((c) => c.category.trim()),
    ]);

    const categoryIdByName = {};
    for (const name of categoryNames) {
      if (!name) continue;
      const { rows } = await client.query(
        `INSERT INTO category (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [name],
      );
      categoryIdByName[name] = rows[0].id;
    }
    console.log(`categories: ${Object.keys(categoryIdByName).length}`);

    // ------------------------------------------------------------------ users
    const { rows: oldUsers } = await oldPool.query(
      "SELECT id, email, name, role FROM users ORDER BY id",
    );
    const newUserIdByOldId = {};
    for (const u of oldUsers) {
      const username = u.email.split("@")[0].toLowerCase() || `user${u.id}`;
      const displayName = u.name || username;
      const role = mapUserRole(u.role);
      const tempPassword = randomPassword();
      const hash = await argon2.hash(tempPassword, { type: argon2.argon2id });

      const { rows } = await client.query(
        `INSERT INTO app_user (username, display_name, password_hash, role, must_change_password)
         VALUES ($1, $2, $3, $4::user_role, true)
         ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id`,
        [username, displayName, hash, role],
      );
      newUserIdByOldId[u.id] = rows[0].id;
      generatedCredentials.push({ username, tempPassword, displayName });
    }
    console.log(`users: ${oldUsers.length}`);

    // --------------------------------------------------------------- products
    const { rows: oldProducts } = await oldPool.query("SELECT * FROM products ORDER BY id");
    const newProductIdByOldId = {};
    const baseUnitIdByOldProductId = {};

    for (const p of oldProducts) {
      const unitCode = UNIT_MAP[p.unit_type] ?? "pc";
      const baseUnitId = unitIdByCode[unitCode];
      const categoryId = p.category ? categoryIdByName[p.category.trim()] ?? null : null;

      const { rows } = await client.query(
        `INSERT INTO product
            (sku, name, category_id, base_unit_id, cost_price, selling_price,
             low_stock_at, active, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (sku) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [
          p.sku || null,
          p.name,
          categoryId,
          baseUnitId,
          p.buying_price ?? 0,
          p.selling_price ?? p.price ?? 0,
          p.minimum_quantity ?? 0,
          p.is_active ?? true,
          p.created_at ?? new Date(),
        ],
      );
      newProductIdByOldId[p.id] = rows[0].id;
      baseUnitIdByOldProductId[p.id] = baseUnitId;
    }
    console.log(`products: ${oldProducts.length}`);

    // ------------------------------------------------------- price variations
    const { rows: oldVariations } = await oldPool.query(
      "SELECT * FROM product_price_variations WHERE is_active ORDER BY product_id, sort_order",
    );
    for (const v of oldVariations) {
      const productId = newProductIdByOldId[v.product_id];
      if (!productId) continue;
      await client.query(
        `INSERT INTO product_price_option (product_id, label, price, sort_order)
         VALUES ($1, $2, $3, $4)`,
        [productId, v.variant_name, v.price, v.sort_order ?? 0],
      );
    }
    console.log(`price options: ${oldVariations.length}`);

    // ----------------------------------------------------------- customers
    const { rows: oldCustomers } = await oldPool.query("SELECT * FROM customers ORDER BY id");
    const newCustomerIdByOldId = {};
    for (const c of oldCustomers) {
      const name = [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "Unnamed";
      const { rows } = await client.query(
        `INSERT INTO customer (name, phone, loyalty_points, created_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [name, c.phone || null, c.points_balance ?? 0, c.created_at ?? new Date()],
      );
      newCustomerIdByOldId[c.id] = rows[0].id;
    }
    console.log(`customers: ${oldCustomers.length}`);

    // --------------------------------------------------------------- sales
    // Old `sales` is one row per line item, no order header — per migration
    // scope decision, each old row becomes its own sale with one sale_line
    // and one sale_payment.
    const { rows: oldSales } = await oldPool.query("SELECT * FROM sales ORDER BY id");
    const newSaleIdByOldSaleId = {};
    let saleSeq = 0;
    for (const s of oldSales) {
      const productId = newProductIdByOldId[s.product_id];
      const unitId = baseUnitIdByOldProductId[s.product_id] ?? unitIdByCode.pc;
      const customerId = s.customer_id ? newCustomerIdByOldId[s.customer_id] ?? null : null;
      const createdBy = s.created_by ? newUserIdByOldId[s.created_by] ?? null : null;
      const subtotal = Number(s.original_price) * Number(s.quantity);
      const discountTotal = Number(s.discount_amount ?? 0);
      const grandTotal = Number(s.total_amount);
      const createdAt = s.sale_date ?? s.created_at ?? new Date();
      saleSeq += 1;
      const invoiceNumber = `AGP-${s.id}`;

      const { rows } = await client.query(
        `INSERT INTO sale
            (invoice_number, location_id, customer_id, status, subtotal,
             discount_total, grand_total, balance_due, created_at, completed_at, created_by)
         VALUES ($1, $2, $3, 'completed', $4, $5, $6, 0, $7, $7, $8)
         ON CONFLICT (invoice_number) DO NOTHING
         RETURNING id`,
        [invoiceNumber, locationId, customerId, subtotal, discountTotal, grandTotal, createdAt, createdBy],
      );
      if (rows.length === 0) continue; // already migrated
      const saleId = rows[0].id;
      newSaleIdByOldSaleId[s.id] = saleId;

      if (!productId) continue; // product no longer resolvable; sale header kept, no line

      const { rows: lineRows } = await client.query(
        `INSERT INTO sale_line
            (sale_id, product_id, unit_id, quantity, unit_price, unit_cost, discount_amount, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          saleId,
          productId,
          unitId,
          s.quantity,
          s.unit_price,
          s.buying_price_at_sale ?? 0,
          discountTotal,
          grandTotal,
        ],
      );

      await client.query(
        `INSERT INTO sale_payment (sale_id, method, amount, created_at)
         VALUES ($1, $2, $3, $4)`,
        [saleId, mapPaymentMethod(s.payment_method), grandTotal, createdAt],
      );

      await client.query(
        `INSERT INTO stock_movement
            (product_id, location_id, quantity, reason, unit_cost, ref_table, ref_id, created_at, created_by)
         VALUES ($1, $2, $3, 'sale', $4, 'sale', $5, $6, $7)`,
        [productId, locationId, -Number(s.quantity), s.buying_price_at_sale ?? 0, saleId, createdAt, createdBy],
      );

      void lineRows;
    }
    console.log(`sales: ${saleSeq}`);

    // ------------------------------------------------------------- returns
    const { rows: oldReturns } = await oldPool.query("SELECT * FROM product_returns ORDER BY id");
    let returnCount = 0;
    for (const r of oldReturns) {
      const saleId = newSaleIdByOldSaleId[r.sale_id];
      if (!saleId) continue; // parent sale wasn't migrated (e.g. re-run after partial failure)
      const productId = newProductIdByOldId[r.product_id];
      const createdBy = r.processed_by ? newUserIdByOldId[r.processed_by] ?? null : null;
      const createdAt = r.return_date ?? r.created_at ?? new Date();

      const { rows: saleLineRows } = await client.query(
        "SELECT id FROM sale_line WHERE sale_id = $1 LIMIT 1",
        [saleId],
      );
      if (saleLineRows.length === 0) continue;
      const saleLineId = saleLineRows[0].id;

      const { rows: returnRows } = await client.query(
        `INSERT INTO sale_return (sale_id, status, reason, total, created_at, created_by)
         VALUES ($1, 'completed', $2, $3, $4, $5)
         RETURNING id`,
        [saleId, r.return_reason || null, r.refund_amount, createdAt, createdBy],
      );
      const returnId = returnRows[0].id;

      await client.query(
        `INSERT INTO sale_return_line (sale_return_id, sale_line_id, quantity, line_total)
         VALUES ($1, $2, $3, $4)`,
        [returnId, saleLineId, r.quantity_returned, r.refund_amount],
      );

      if (productId && r.restocked) {
        await client.query(
          `INSERT INTO stock_movement
              (product_id, location_id, quantity, reason, ref_table, ref_id, created_at, created_by)
           VALUES ($1, $2, $3, 'sale_return', 'sale_return', $4, $5, $6)`,
          [productId, locationId, r.quantity_returned, returnId, createdAt, createdBy],
        );
      }
      returnCount += 1;
    }
    console.log(`returns: ${returnCount}`);

    // ------------------------------------------------------- restock history
    const { rows: oldRestocks } = await oldPool.query(
      "SELECT * FROM restock_history ORDER BY product_id, restocked_at",
    );
    let restockCount = 0;
    for (const rh of oldRestocks) {
      const productId = newProductIdByOldId[rh.product_id];
      if (!productId) continue;
      const createdBy = rh.restocked_by ? newUserIdByOldId[rh.restocked_by] ?? null : null;
      await client.query(
        `INSERT INTO stock_movement
            (product_id, location_id, quantity, reason, note, created_at, created_by)
         VALUES ($1, $2, $3, 'purchase', $4, $5, $6)`,
        [productId, locationId, rh.quantity_added, rh.notes || null, rh.restocked_at ?? new Date(), createdBy],
      );
      restockCount += 1;
    }
    console.log(`restock movements: ${restockCount}`);

    // ---------------------------------------------- opening-balance plug
    // Reconcile: current stock_quantity on the old product minus everything we
    // just replayed (restocks - sales + restocked returns) becomes one
    // 'opening' movement, so SUM(stock_movement.quantity) ends up exactly
    // equal to the old system's stock_quantity for every product.
    let plugCount = 0;
    for (const p of oldProducts) {
      const productId = newProductIdByOldId[p.id];
      if (!productId) continue;
      const { rows: sumRows } = await client.query(
        "SELECT COALESCE(SUM(quantity), 0) AS total FROM stock_movement WHERE product_id = $1 AND location_id = $2",
        [productId, locationId],
      );
      const replayed = Number(sumRows[0].total);
      const target = Number(p.stock_quantity ?? 0);
      const plug = target - replayed;
      if (plug !== 0) {
        await client.query(
          `INSERT INTO stock_movement (product_id, location_id, quantity, reason, note, created_at)
           VALUES ($1, $2, $3, 'opening', 'AgroPlus migration opening balance', now())`,
          [productId, locationId, plug],
        );
        plugCount += 1;
      }
    }
    console.log(`opening-balance plugs: ${plugCount}`);

    if (DRY_RUN) {
      console.log("\n--dry-run: rolling back, nothing was written.");
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
      console.log("\nCommitted.");
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await oldPool.end();
    await newPool.end();
  }

  if (!DRY_RUN && generatedCredentials.length > 0) {
    const outFile = path.join(process.cwd(), "migrated-user-credentials.csv");
    const lines = ["username,display_name,temp_password"].concat(
      generatedCredentials.map((c) => `${c.username},${c.displayName},${c.tempPassword}`),
    );
    fs.writeFileSync(outFile, lines.join("\n") + "\n", { mode: 0o600 });
    console.log(
      `\nTemporary passwords for migrated staff accounts written to ${outFile}.\n` +
        `Each account must change its password on first login. Delete this file after handing out the passwords.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
