import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";

const COLORS={ink:"#101828",muted:"#667085",line:"#D0D5DD",soft:"#F2F4F7",brand:"#155EEF",ok:"#067647",greenSoft:"#ECFDF3"};
const LOGO_PATH=fileURLToPath(new URL("./public/admin/assets/img/pdf/RAZAFI.png",import.meta.url));
const FONT_REGULAR=fileURLToPath(new URL("./public/admin/assets/fonts/pdf/DejaVuSans.ttf",import.meta.url));
const FONT_BOLD=fileURLToPath(new URL("./public/admin/assets/fonts/pdf/DejaVuSans-Bold.ttf",import.meta.url));
const safe=(v,fallback="-")=>String(v??"").trim()||fallback;
const amount=(v)=>`${Math.round(Number(v)||0).toLocaleString("fr-FR").replace(/[\u00A0\u202F]/g," ")} Ar`;
const poolName=(p)=>[p?.brand_name,p?.name].filter(Boolean).join(" - ")||"Pool RAZAFI";
const dateFR=(value)=>{
  if(!value)return "-";
  const raw=String(value),d=/^\d{4}-\d{2}-\d{2}$/.test(raw)?new Date(`${raw}T12:00:00Z`):new Date(raw);
  if(Number.isNaN(d.getTime()))return raw;
  return new Intl.DateTimeFormat("fr-FR",{timeZone:"Indian/Antananarivo",day:"2-digit",month:"2-digit",year:"numeric"}).format(d);
};
const dateTimeFR=(value)=>{
  if(!value)return "-";
  const d=new Date(value);if(Number.isNaN(d.getTime()))return String(value);
  return new Intl.DateTimeFormat("fr-FR",{timeZone:"Indian/Antananarivo",day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"}).format(d);
};
const methodLabel=(v)=>({mvola:"MVola",airtel_money:"Airtel Money",orange_money:"Orange Money",bank:"Virement bancaire",cash:"Espèces",other:"Autre"})[v]||safe(v);

function font(doc,bold=false,size=10,color=COLORS.ink){return doc.font(bold?"Bold":"Regular").fontSize(size).fillOpacity(1).fillColor(color)}
function drawLogo(doc){doc.image(LOGO_PATH,48,43,{fit:[142,48]});font(doc,false,8.5,COLORS.muted).text("La plateforme WiFi intelligente",48,82,{width:180,lineGap:0})}
function pair(doc,label,value,x,y,width=220){font(doc,false,9,COLORS.muted).text(label,x,y,{width,lineGap:0});font(doc,true,10.5).text(safe(value),x,y+16,{width,lineGap:0})}
function stamp(doc,label,x,y,width){doc.save().rotate(-5,{origin:[x+width/2,y+18]}).roundedRect(x,y,width,36,6).lineWidth(2).strokeColor(COLORS.ok).stroke();font(doc,true,13,COLORS.ok).text(label,x,y+10,{width,align:"center",lineGap:0});doc.restore()}
function issuer(doc,y){font(doc,true,9).text("ÉMIS PAR",48,y,{width:250,lineGap:0});font(doc,true,11).text("RAZAFI",48,y+18,{width:250,lineGap:0});font(doc,false,8.8,COLORS.muted).text("Exploité par RAZAFINDRAMASY Sosthène",48,y+36,{width:280,lineGap:0})}
function footer(doc,note){const y=742;doc.moveTo(48,y-12).lineTo(547,y-12).lineWidth(1).strokeColor(COLORS.line).stroke();font(doc,false,7.8,COLORS.muted)
  .text("RAZAFI - Exploité par RAZAFINDRAMASY Sosthène - NIF : 5004006983 - STAT : 46900 11 2020 0 02222",48,y,{width:499,align:"center",lineGap:0})
  .text("Lot IBI 34, Amboasarikely, Madagascar - www.razafistore.com",48,y+13,{width:499,align:"center",lineGap:0})
  .text(note,48,y+26,{width:499,align:"center",lineGap:0})}
function base(title,number,subject){const doc=new PDFDocument({size:"A4",margin:48,info:{Title:`${title} ${number}`,Author:"RAZAFI - RAZAFINDRAMASY Sosthène",Subject:subject,Creator:"RAZAFI Billing v1 S13.8.4.4"}});doc.registerFont("Regular",FONT_REGULAR).registerFont("Bold",FONT_BOLD);drawLogo(doc);font(doc,true,title.length>22?14:17,COLORS.brand).text(title,247,47,{width:300,align:"right",lineBreak:false});font(doc,true,9.5).text(safe(number),247,75,{width:300,align:"right",lineBreak:false});doc.moveTo(48,99).lineTo(547,99).lineWidth(1).strokeColor(COLORS.line).stroke();return doc}

export function createCommissionStatementPdf({statement:s,pool:p,owner:o}){
  const doc=base("RELEVÉ MENSUEL COMMISSION",s.statement_number,"Relevé mensuel de commission RAZAFI");
  doc.roundedRect(48,120,499,94,12).fill(COLORS.soft);pair(doc,"PROPRIÉTAIRE",o?.email,64,138);pair(doc,"POOL",poolName(p),310,138);pair(doc,"PÉRIODE",`${dateFR(s.period_start)} au ${dateFR(s.period_end)}`,64,177);pair(doc,"STATUT","Clôturé - immuable",310,177);
  font(doc,true,13).text("Synthèse financière",48,246);doc.moveTo(48,270).lineTo(547,270).strokeColor(COLORS.line).stroke();
  font(doc,true,9,COLORS.muted).text("DESCRIPTION",58,283,{width:270}).text("TAUX",340,283,{width:80,align:"right"}).text("MONTANT",437,283,{width:100,align:"right"});
  const rows=[["Ventes payées","100 %",amount(s.gross_sales_ar)],["Commission RAZAFI",`${Number(s.commission_pct||0).toLocaleString("fr-FR")} %`,amount(s.commission_amount_ar)],["Part propriétaire brute",`${Number(s.owner_share_pct||0).toLocaleString("fr-FR")} %`,amount(s.owner_gross_amount_ar)]];
  rows.forEach((r,i)=>{const y=315+i*38;font(doc,i===2,10).text(r[0],58,y,{width:270}).text(r[1],340,y,{width:80,align:"right"}).text(r[2],437,y,{width:100,align:"right"});doc.moveTo(48,y+25).lineTo(547,y+25).strokeColor(COLORS.line).stroke()});
  doc.roundedRect(48,448,499,80,12).fill(COLORS.greenSoft);pair(doc,"VENTES PAYÉES INCLUSES",`${Number(s.transaction_count||0)} transaction(s)`,66,466,205);pair(doc,"PART PROPRIÉTAIRE À REVERSER",amount(s.owner_gross_amount_ar),310,466,220);
  font(doc,false,8.7,COLORS.muted).text(`Source financière : ${safe(s.source_name,"v_revenue_paid_truth")} - Empreinte : ${safe(s.source_checksum)}`,48,552,{width:499,align:"center"}).text("Les frais du transfert final ne sont pas inclus dans ce relevé. Ils seront indiqués sur le reçu après reversement.",48,572,{width:499,align:"center"});
  stamp(doc,"RELEVÉ CLÔTURÉ",361,610,174);issuer(doc,638);footer(doc,"Relevé financier mensuel limité aux ventes WiFi payées du pool indiqué.");return doc;
}

export function createCommissionPayoutReceiptPdf({statement:s,pool:p,owner:o,payout:x}){
  const doc=base("REÇU DE REVERSEMENT",x.receipt_number,"Reçu de reversement propriétaire RAZAFI");
  doc.roundedRect(48,120,499,94,12).fill(COLORS.greenSoft);pair(doc,"REÇU POUR",o?.email,64,138);pair(doc,"POOL",poolName(p),310,138);pair(doc,"RELEVÉ",s.statement_number,64,177);pair(doc,"REVERSEMENT","Confirmé",310,177);
  font(doc,true,13).text("Reversement confirmé",48,246);doc.roundedRect(48,274,499,150,12).strokeColor(COLORS.line).stroke();pair(doc,"PART PROPRIÉTAIRE BRUTE",amount(x.owner_gross_amount_ar),66,294,210);pair(doc,"FRAIS DU TRANSFERT FINAL",amount(x.transfer_fee_ar),310,294,210);pair(doc,"MONTANT NET REVERSÉ",amount(x.owner_net_amount_ar),66,350,210);pair(doc,"MÉTHODE",methodLabel(x.transfer_method),310,350,210);
  font(doc,true,15,COLORS.ok).text(`Montant reçu : ${amount(x.owner_net_amount_ar)}`,48,458,{width:499,align:"center"});font(doc,false,9.5,COLORS.muted).text(`Référence du transfert : ${safe(x.transfer_reference)}`,48,496,{width:499,align:"center"}).text(`Date du transfert : ${dateTimeFR(x.transferred_at)}`,48,515,{width:499,align:"center"}).text(`Période concernée : ${dateFR(s.period_start)} au ${dateFR(s.period_end)}`,48,534,{width:499,align:"center"});
  if(x.transfer_note)font(doc,false,8.7,COLORS.muted).text(`Note : ${safe(x.transfer_note)}`,48,558,{width:499,align:"center"});
  stamp(doc,"REVERSEMENT CONFIRMÉ",328,594,207);issuer(doc,638);footer(doc,"Reçu limité au reversement propriétaire indiqué. Aucun code WiFi ni voucher n'est généré.");return doc;
}
