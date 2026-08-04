/** Phí giao dịch và thuế theo quy định VN. Hàm thuần, đơn vị VND. */

export const FEE_RATE = 0.0015;      // 0,15% cả mua lẫn bán
export const SELL_TAX_RATE = 0.001;  // 0,1% thuế TNCN, chỉ khi bán

function validate(fnName, priceVnd, qty) {
  if (typeof priceVnd !== 'number' || !Number.isFinite(priceVnd) || priceVnd <= 0) {
    throw new Error(`${fnName}: priceVnd phải là số dương hữu hạn, nhận được: ${priceVnd}`);
  }
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error(`${fnName}: qty phải là số nguyên dương, nhận được: ${qty}`);
  }
}

export function buyCost({ priceVnd, qty }) {
  validate('buyCost', priceVnd, qty);
  const gross = Math.round(priceVnd * qty);
  const fee = Math.round(gross * FEE_RATE);
  return { gross, fee, tax: 0, total: gross + fee };
}

export function sellProceeds({ priceVnd, qty }) {
  validate('sellProceeds', priceVnd, qty);
  const gross = Math.round(priceVnd * qty);
  const fee = Math.round(gross * FEE_RATE);
  const tax = Math.round(gross * SELL_TAX_RATE);
  return { gross, fee, tax, net: gross - fee - tax };
}
