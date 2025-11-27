const supabase = window.supabase.createClient(
  'https://owqgbluagwwlopdbwvqn.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93cWdibHVhZ3d3bG9wZGJ3dnFuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTIzOTg2ODQsImV4cCI6MjA2Nzk3NDY4NH0.Xnax3uenBUWZG7T_R9JGAgtc554u4h92nd5MznGlazU'
);

let selectedPlan = '';
let codeJustGenerated = false;

async function handlePayment(planLabel) {
  selectedPlan = planLabel;
  const confirmed = confirm(`${planLabel}\n\nPayer via Mvola ?`);
  if (!confirmed) return;

  const phone = prompt('Entrez votre numéro Mvola:');
  if (!phone || phone.length < 9) {
    alert('Numéro invalide.');
    return;
  }

  setTimeout(async () => {
    const { data, error } = await supabase
      .from('vouchers')
      .select('*')
      .eq('plan', planLabel)
      .is('paid_by', null)
      .limit(1);

    if (error || !data || data.length === 0) {
      showToast('❌ Aucun code disponible pour ce plan.');
      return;
    }

    const voucher = data[0];
    const mgTime = new Date().toLocaleString('sv-SE', {
      timeZone: 'Indian/Antananarivo'
    }).replace(' ', 'T');

    await supabase
      .from('vouchers')
      .update({
        paid_by: phone,
        assigned_at: mgTime
      })
      .eq('id', voucher.id);

    localStorage.setItem('voucher_code', voucher.code);
    localStorage.setItem('voucher_plan', planLabel);
    localStorage.setItem('code_not_copied', 'yes');
    codeJustGenerated = true;
    showCodeSection(voucher.code, planLabel, true);
    showCopyWarning();
  }, 1500);
}

function showCodeSection(code, plan, isNew) {
  document.getElementById('codeValue').textContent = code;
  document.getElementById('codePlan').textContent = plan;
  document.getElementById('codeSectionTitle').textContent = isNew
    ? '🎉 Paiement réussi'
    : '🔐 Votre dernier code WiFi';
  document.getElementById('codeSection').classList.remove('hidden');
}

function copySavedCode() {
  const code = localStorage.getItem('voucher_code');
  if (!navigator.clipboard) {
    fallbackCopy(code);
    return;
  }
  navigator.clipboard.writeText(code).then(() => {
    showToast('📋 Code copié ! Utilisez-le sur le WiFi RAZAFI');
    localStorage.removeItem('code_not_copied');
    hideCopyWarning();
  }, () => fallbackCopy(code));
}

function fallbackCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = 0;
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    document.execCommand('copy');
    showToast('📋 Code copié (fallback)');
    localStorage.removeItem('code_not_copied');
    hideCopyWarning();
  } catch (err) {
    alert('Impossible de copier automatiquement. Veuillez copier manuellement.');
  }
  document.body.removeChild(textarea);
}

function showSavedCode() {
  const code = localStorage.getItem('voucher_code');
  const plan = localStorage.getItem('voucher_plan');
  if (code && plan && !codeJustGenerated) {
    showCodeSection(code, plan, false);
  }
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.innerHTML = message;
  toast.classList.remove('hidden');
  toast.classList.add('show');
  setTimeout(() => toast.classList.add('hidden'), 4500);
}

function showCopyWarning() {
  document.getElementById('copyWarning').classList.remove('hidden');
}

function hideCopyWarning() {
  document.getElementById('copyWarning').classList.add('hidden');
}

window.onload = () => {
  showSavedCode();
  if (localStorage.getItem('code_not_copied')) showCopyWarning();
};

window.addEventListener('beforeunload', function (e) {
  if (localStorage.getItem('code_not_copied')) {
    e.preventDefault();
    e.returnValue = 'Vous avez un code non copié. Êtes-vous sûr de vouloir quitter ?';
  }
});
