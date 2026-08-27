import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";

const COLORS={ink:"#101828",muted:"#667085",line:"#D0D5DD",soft:"#F2F4F7",brand:"#155EEF",ok:"#067647"};
const RAZAFI_LOGO_PATH=fileURLToPath(new URL("./public/admin/assets/img/pdf/RAZAFI.png",import.meta.url));
const PDF_FONT_REGULAR_PATH=fileURLToPath(new URL("./public/admin/assets/fonts/pdf/DejaVuSans.ttf",import.meta.url));
const PDF_FONT_BOLD_PATH=fileURLToPath(new URL("./public/admin/assets/fonts/pdf/DejaVuSans-Bold.ttf",import.meta.url));
const safe=(value,fallback="-")=>String(value??"").trim()||fallback;
const amount=(value)=>`${Math.round(Number(value)||0).toLocaleString("fr-FR").replace(/[\u00A0\u202F]/g," ")} Ar`;
const dateFR=(value)=>{
  if(!value)return "-";
  const raw=String(value);
  const d=/^\d{4}-\d{2}-\d{2}$/.test(raw)?new Date(raw+"T12:00:00Z"):new Date(raw);
  if(Number.isNaN(d.getTime()))return raw;
  return new Intl.DateTimeFormat("fr-FR",{timeZone:"Indian/Antananarivo",day:"2-digit",month:"2-digit",year:"numeric"}).format(d);
};
const dateTimeFR=(value)=>{
  if(!value)return "-";
  const d=new Date(value);if(Number.isNaN(d.getTime()))return String(value);
  return new Intl.DateTimeFormat("fr-FR",{timeZone:"Indian/Antananarivo",day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"}).format(d);
};
const statusLabel=(value)=>({issued:"Émise",pending:"En attente",paid:"Payée",cancelled:"Annulée",refunded:"Remboursée",partially_refunded:"Partiellement remboursée",completed:"Confirmé"})[value]||safe(value);

function typography(doc,font="Helvetica",size=10){
  // S11.11: reset PDFKit text state before every block. This prevents inherited
  // spacing/transform state from producing irregular gaps in browser PDF viewers.
  return doc.font(font).fontSize(size).fillOpacity(1);
}

function textPair(doc,label,value,x,y,width=230){
  typography(doc,"Helvetica",9).fillColor(COLORS.muted).text(label,x,y,{width,lineGap:0});
  typography(doc,"Helvetica-Bold",10.5).fillColor(COLORS.ink).text(safe(value),x,y+14,{width,lineGap:0});
}
function drawLogo(doc){
  doc.image(RAZAFI_LOGO_PATH,48,43,{fit:[142,48],align:"left",valign:"center"});
  typography(doc,"Helvetica",8.5).fillColor(COLORS.muted)
    .text("La plateforme WiFi intelligente",48,82,{width:180,lineGap:0});
}
function drawStatusStamp(doc,label,x,y,width=142){
  doc.save();
  doc.rotate(-5,{origin:[x+width/2,y+18]});
  doc.roundedRect(x,y,width,36,6).lineWidth(2).strokeColor(COLORS.ok).stroke();
  typography(doc,"Helvetica-Bold",13).fillColor(COLORS.ok)
    .text(label,x,y+10,{width,align:"center",lineGap:0});
  doc.restore();
}
function issuerBlock(doc,y){
  typography(doc,"Helvetica-Bold",9).fillColor(COLORS.ink).text("ÉMIS PAR",48,y,{width:210,lineGap:0});
  typography(doc,"Helvetica-Bold",11).fillColor(COLORS.ink).text("RAZAFI",48,y+17,{width:210,lineGap:0});
  typography(doc,"Helvetica",8.8).fillColor(COLORS.muted)
    .text("Exploité par RAZAFINDRAMASY Sosthène",48,y+34,{width:260,lineGap:1})
    .text("Lot IBI 34, Amboasarikely, Madagascar",48,y+48,{width:260,lineGap:1})
    .text("Document généré électroniquement",48,y+62,{width:260,lineGap:1});
}
function baseDocument({title,number,uat=false}){
  const doc=new PDFDocument({size:"A4",margin:48,info:{Title:`${title} ${number}`,Author:"RAZAFI - RAZAFINDRAMASY Sosthène",Subject:"Abonnement RAZAFI",Creator:"RAZAFI Billing v1 S13.7.1"}});
  // Embed deterministic fonts so invoices render identically in browsers,
  // PDF readers and Render, without relying on PDFKit's base-font metrics.
  doc.registerFont("Helvetica",PDF_FONT_REGULAR_PATH);
  doc.registerFont("Helvetica-Bold",PDF_FONT_BOLD_PATH);
  drawLogo(doc);
  doc.fillColor(COLORS.brand).font("Helvetica-Bold").fontSize(17).text(title,300,46,{width:247,align:"right"});
  doc.fillColor(COLORS.ink).font("Helvetica-Bold").fontSize(9.5).text(safe(number),300,72,{width:247,align:"right"});
  doc.moveTo(48,99).lineTo(547,99).lineWidth(1).strokeColor(COLORS.line).stroke();
  if(uat){
    typography(doc,"Helvetica-Bold",8).fillColor("#C01048")
      .text("TEST / UAT - SANS VALEUR",220,87,{width:155,align:"center"});
    doc.save();typography(doc,"Helvetica-Bold",54).fillOpacity(.08).fillColor("#C01048")
      .rotate(-28,{origin:[300,430]}).text("TEST UAT",80,390,{width:470,align:"center"}).restore();
  }
  return doc;
}
function footer(doc){
  const y=742;
  doc.moveTo(48,y-12).lineTo(547,y-12).lineWidth(1).strokeColor(COLORS.line).stroke();
  typography(doc,"Helvetica",7.8).fillColor(COLORS.muted)
    .text("RAZAFI - Exploité par RAZAFINDRAMASY Sosthène - NIF : 5004006983 - STAT : 46900 11 2020 0 02222",48,y,{width:499,align:"center",lineGap:0})
    .text("Lot IBI 34, Amboasarikely, Madagascar - www.razafistore.com",48,y+13,{width:499,align:"center",lineGap:0})
    .text("Document limité à l'abonnement RAZAFI. Aucun code WiFi ni voucher n'est généré.",48,y+26,{width:499,align:"center",lineGap:0});
}
function invoiceBody(doc,{invoice,pool,owner}){
  doc.roundedRect(48,120,499,94,12).fill(COLORS.soft);
  textPair(doc,"PROPRIÉTAIRE",owner?.email,64,138,220);
  textPair(doc,"POOL",pool?.display_name||pool?.name,310,138,220);
  textPair(doc,"IDENTIFIANT DU POOL",pool?.radius_nas_id,64,177,220);
  textPair(doc,"STATUT",statusLabel(invoice.status),310,177,220);

  doc.fillColor(COLORS.ink).font("Helvetica-Bold").fontSize(13).text("Détails de l'abonnement",48,244);
  doc.moveTo(48,268).lineTo(547,268).strokeColor(COLORS.line).stroke();
  doc.fillColor(COLORS.muted).font("Helvetica-Bold").fontSize(9)
    .text("DESCRIPTION",58,280,{width:250}).text("PÉRIODE",322,280,{width:120}).text("MONTANT",447,280,{width:90,align:"right"});
  doc.fillColor(COLORS.ink).font("Helvetica").fontSize(10.5)
    .text(`Abonnement RAZAFI - ${safe(invoice.offer_title_snapshot)}`,58,306,{width:250})
    .text(`${dateFR(invoice.period_start)} au ${dateFR(invoice.period_end)}`,322,306,{width:120})
    .font("Helvetica-Bold").text(amount(invoice.amount_due_ar),447,306,{width:90,align:"right"});
  doc.moveTo(48,346).lineTo(547,346).strokeColor(COLORS.line).stroke();

  doc.roundedRect(322,372,225,92,12).fill(COLORS.soft);
  doc.fillColor(COLORS.muted).font("Helvetica").fontSize(9).text("TOTAL",340,389);
  doc.fillColor(COLORS.ink).font("Helvetica-Bold").fontSize(20).text(amount(invoice.amount_due_ar),340,408,{width:188,align:"right"});
  doc.fillColor(COLORS.muted).font("Helvetica").fontSize(9).text(`Échéance : ${dateFR(invoice.due_at)}`,340,440,{width:188,align:"right"});

  doc.fillColor(COLORS.ink).font("Helvetica-Bold").fontSize(11).text("Informations",48,390);
  doc.fillColor(COLORS.muted).font("Helvetica").fontSize(9.5)
    .text(`Date d'émission : ${dateFR(invoice.issued_at||invoice.created_at)}`,48,414)
    .text(`Montant payé : ${amount(invoice.amount_paid_ar)}`,48,432)
    .text("Devise : Ariary malgache (Ar)",48,450);
  if(invoice.status==="paid")drawStatusStamp(doc,"PAYÉ",390,494,130);
  issuerBlock(doc,566);
  footer(doc);
}
function receiptBody(doc,{invoice,pool,owner,transaction,receipt_number}){
  doc.roundedRect(48,120,499,94,12).fill("#ECFDF3");
  textPair(doc,"REÇU POUR",owner?.email,64,138,220);
  textPair(doc,"POOL",pool?.display_name||pool?.name,310,138,220);
  textPair(doc,"FACTURE",invoice.invoice_number,64,177,220);
  textPair(doc,"PAIEMENT",statusLabel(transaction.status),310,177,220);

  doc.fillColor(COLORS.ink).font("Helvetica-Bold").fontSize(13).text("Paiement confirmé",48,246);
  doc.roundedRect(48,274,499,122,12).strokeColor(COLORS.line).stroke();
  textPair(doc,"MONTANT REÇU",amount(transaction.amount_ar),66,292,210);
  textPair(doc,"OPÉRATEUR",String(transaction.provider||"mvola").toUpperCase(),310,292,210);
  textPair(doc,"DATE DE CONFIRMATION",dateTimeFR(transaction.completed_at),66,344,210);
  textPair(doc,"RÉFÉRENCE DU REÇU",receipt_number,310,344,210);

  doc.fillColor(COLORS.ok).font("Helvetica-Bold").fontSize(15).text("Règlement enregistré",48,430,{width:499,align:"center"});
  doc.fillColor(COLORS.muted).font("Helvetica").fontSize(9.5)
    .text(`Abonnement : ${safe(invoice.offer_title_snapshot)}`,48,468,{width:499,align:"center"})
    .text(`Période couverte : ${dateFR(invoice.period_start)} au ${dateFR(invoice.period_end)}`,48,486,{width:499,align:"center"})
    .text("Le numéro payeur et les réponses techniques de l'opérateur ne figurent pas sur ce document.",48,522,{width:499,align:"center"});
  drawStatusStamp(doc,"PAIEMENT CONFIRMÉ",344,556,190);
  issuerBlock(doc,622);
  footer(doc);
}

export function createSubscriptionInvoicePdf(data){
  const doc=baseDocument({title:data.uat?"FACTURE UAT":"FACTURE D'ABONNEMENT",number:data.invoice.invoice_number,uat:!!data.uat});
  invoiceBody(doc,data);return doc;
}
export function createSubscriptionReceiptPdf(data){
  const receipt_number=data.receipt_number||`RAZAFI-REC-${safe(data.invoice.invoice_number)}`;
  const doc=baseDocument({title:data.uat?"REÇU UAT":"REÇU DE PAIEMENT",number:receipt_number,uat:!!data.uat});
  receiptBody(doc,{...data,receipt_number});return doc;
}
