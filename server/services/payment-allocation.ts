import { and, eq } from "drizzle-orm";
import { certificatSources, invoices } from "@shared/schema";
import type { db } from "../db";
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export class PaymentInputError extends Error {
  constructor(message:string, public status=409) {super(message);}
}
export type PaymentEvidence = {evidenceStorageKey:string;evidenceFileName:string;evidenceHash:string};
export async function paymentInvoiceOptions(tx: Pick<Tx,"select">, certificatId:number) {
  return tx.select({id:invoices.id,invoiceNumber:invoices.invoiceNumber,amountTtc:invoices.amountTtc})
    .from(certificatSources).innerJoin(invoices,eq(certificatSources.invoiceId,invoices.id))
    .where(eq(certificatSources.certificatId,certificatId));
}
export async function validatePaymentAllocation(tx:Tx,certificatId:number,amount:string,
  allocations?:{invoiceId:number;amount:string}[]) {
  const linked = await paymentInvoiceOptions(tx,certificatId);
  const result = allocations?.length ? allocations : linked.length===1
    ? [{invoiceId:linked[0].id,amount}] : [];
  if (linked.length>1 && !result.length) throw new PaymentInputError("Allocate this payment between the certificate's invoices.");
  if (new Set(result.map(x=>x.invoiceId)).size !== result.length ||
      result.some(x=>!linked.some(i=>i.id===x.invoiceId) || !/^\d{1,10}(\.\d{1,2})?$/.test(x.amount) || Number(x.amount)<=0))
    throw new PaymentInputError("Payment allocation contains an invalid or unrelated invoice.");
  if (result.length && result.reduce((n,x)=>n+Math.round(Number(x.amount)*100),0)!==Math.round(Number(amount)*100))
    throw new PaymentInputError("Invoice allocations must equal the payment amount.");
  return result;
}
