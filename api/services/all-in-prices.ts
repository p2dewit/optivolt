import type { TimeSeries } from '../types.ts';
import type { Settings } from '../types.ts';

type PriceFormulaSettings = Pick<
  Settings,
  'energyTax_eur_per_kWh' | 'buyCost_eur_per_kWh' | 'sellCost_eur_per_kWh' | 'vat_percent' | 'netMetering'
>;

/** Convert base EPEX imports (c€/kWh) to all-in imports using €/kWh settings. */
export function toAllInImportPrices(base: TimeSeries, settings: PriceFormulaSettings): TimeSeries {
  const vatFactor = 1 + settings.vat_percent / 100;
  const additionCents = (settings.buyCost_eur_per_kWh + settings.energyTax_eur_per_kWh) * 100;
  return { ...base, values: base.values.map(price => (price + additionCents) * vatFactor) };
}

/** Undo the import formula for legacy stored all-in series that predate base-series retention. */
export function toBaseEpexImportPrices(allIn: TimeSeries, settings: PriceFormulaSettings): TimeSeries {
  const vatFactor = 1 + settings.vat_percent / 100;
  if (vatFactor <= 0) throw new Error('VAT must produce a positive multiplier');
  const additionCents = (settings.buyCost_eur_per_kWh + settings.energyTax_eur_per_kWh) * 100;
  return { ...allIn, values: allIn.values.map(price => price / vatFactor - additionCents) };
}

/** Convert base EPEX exports (c€/kWh) to all-in exports using the net-metering setting. */
export function toAllInExportPrices(base: TimeSeries, settings: PriceFormulaSettings): TimeSeries {
  const vatFactor = 1 + settings.vat_percent / 100;
  const taxedEnergy = settings.netMetering ? settings.energyTax_eur_per_kWh : 0;
  const adjustmentCents = (taxedEnergy - settings.sellCost_eur_per_kWh) * 100;
  return { ...base, values: base.values.map(price => (price + adjustmentCents) * vatFactor) };
}

/** Undo the export formula for legacy stored all-in series that predate base-series retention. */
export function toBaseEpexExportPrices(allIn: TimeSeries, settings: PriceFormulaSettings): TimeSeries {
  const vatFactor = 1 + settings.vat_percent / 100;
  if (vatFactor <= 0) throw new Error('VAT must produce a positive multiplier');
  const taxedEnergy = settings.netMetering ? settings.energyTax_eur_per_kWh : 0;
  const adjustmentCents = (taxedEnergy - settings.sellCost_eur_per_kWh) * 100;
  return { ...allIn, values: allIn.values.map(price => price / vatFactor - adjustmentCents) };
}
