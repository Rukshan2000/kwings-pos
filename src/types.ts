export type Item = {
  id: string;
  name: string;
  qty: number;
  price: number;
};

export type Bill = {
  billNumber: string;
  date: Date;
  items: Item[];
};

export const lineTotal = (i: Item) => i.qty * i.price;
export const subtotal = (items: Item[]) => items.reduce((s, i) => s + lineTotal(i), 0);
export const money = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
