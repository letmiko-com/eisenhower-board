import nodemailer from 'nodemailer';

export interface SendMagicLinkParams {
  to: string;
  link: string;
  expiresInMinutes: number;
  language?: string;
}

const SUPPORTED_LANGUAGES = ['en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'pl', 'ru', 'uk', 'zh', 'hi', 'ar', 'bn'] as const;
type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

const APP_NAME = 'Focus by Eisenhower';

const EMAIL_COPY: Record<SupportedLanguage, {
  subject: string;
  greeting: string;
  body: string;
  expires: string;
  ignore: string;
}> = {
  en: {
    subject: 'Your secure sign-in link',
    greeting: 'Hello,',
    body: `You requested to sign in to ${APP_NAME}. Click the link below to access your space:`,
    expires: 'This link expires in {minutes} minutes and can only be used once.',
    ignore: 'If you did not request this, please ignore this email.',
  },
  fr: {
    subject: 'Votre lien de connexion sécurisé',
    greeting: 'Bonjour,',
    body: `Vous avez demandé à vous connecter à ${APP_NAME}. Cliquez sur le lien ci-dessous pour accéder à votre espace :`,
    expires: 'Ce lien expire dans {minutes} minutes et ne peut être utilisé qu\u2019une seule fois.',
    ignore: 'Si vous n\u2019êtes pas à l\u2019origine de cette demande, ignorez cet email.',
  },
  de: {
    subject: 'Ihr sicherer Anmeldelink',
    greeting: 'Hallo,',
    body: `Sie haben eine Anmeldung bei ${APP_NAME} angefordert. Klicken Sie auf den folgenden Link, um auf Ihren Bereich zuzugreifen:`,
    expires: 'Dieser Link läuft in {minutes} Minuten ab und kann nur einmal verwendet werden.',
    ignore: 'Wenn Sie diese Anfrage nicht gestellt haben, ignorieren Sie bitte diese E-Mail.',
  },
  es: {
    subject: 'Tu enlace de acceso seguro',
    greeting: 'Hola,',
    body: `Has solicitado iniciar sesión en ${APP_NAME}. Haz clic en el enlace de abajo para acceder a tu espacio:`,
    expires: 'Este enlace caduca en {minutes} minutos y solo puede usarse una vez.',
    ignore: 'Si no has solicitado esto, ignora este correo.',
  },
  it: {
    subject: 'Il tuo link di accesso sicuro',
    greeting: 'Ciao,',
    body: `Hai richiesto l'accesso a ${APP_NAME}. Clicca sul link qui sotto per accedere al tuo spazio:`,
    expires: 'Questo link scade tra {minutes} minuti e può essere usato una sola volta.',
    ignore: 'Se non hai effettuato questa richiesta, ignora questa email.',
  },
  pt: {
    subject: 'Seu link de acesso seguro',
    greeting: 'Olá,',
    body: `Você solicitou acesso ao ${APP_NAME}. Clique no link abaixo para acessar seu espaço:`,
    expires: 'Este link expira em {minutes} minutos e só pode ser usado uma vez.',
    ignore: 'Se você não fez esta solicitação, ignore este email.',
  },
  nl: {
    subject: 'Uw beveiligde aanmeldlink',
    greeting: 'Hallo,',
    body: `U heeft aanmelding bij ${APP_NAME} aangevraagd. Klik op de onderstaande link om toegang te krijgen tot uw ruimte:`,
    expires: 'Deze link verloopt over {minutes} minuten en kan slechts één keer worden gebruikt.',
    ignore: 'Als u dit niet heeft aangevraagd, kunt u deze e-mail negeren.',
  },
  pl: {
    subject: 'Twój bezpieczny link do logowania',
    greeting: 'Cześć,',
    body: `Poprosiłeś o zalogowanie się do ${APP_NAME}. Kliknij poniższy link, aby uzyskać dostęp do swojej przestrzeni:`,
    expires: 'Ten link wygasa za {minutes} minut i może być użyty tylko raz.',
    ignore: 'Jeśli nie wysłałeś tego żądania, zignoruj tego e-maila.',
  },
  ru: {
    subject: 'Ваша безопасная ссылка для входа',
    greeting: 'Здравствуйте,',
    body: `Вы запросили вход в ${APP_NAME}. Нажмите на ссылку ниже, чтобы получить доступ к вашему пространству:`,
    expires: 'Эта ссылка истекает через {minutes} минут и может быть использована только один раз.',
    ignore: 'Если вы не отправляли этот запрос, проигнорируйте это письмо.',
  },
  uk: {
    subject: 'Ваше безпечне посилання для входу',
    greeting: 'Вітаємо,',
    body: `Ви запросили вхід до ${APP_NAME}. Натисніть на посилання нижче, щоб отримати доступ до вашого простору:`,
    expires: 'Це посилання дійсне {minutes} хвилин і може бути використане лише один раз.',
    ignore: 'Якщо ви не надсилали цей запит, проігноруйте цей лист.',
  },
  zh: {
    subject: '您的安全登录链接',
    greeting: '您好，',
    body: `您请求登录 ${APP_NAME}。请点击以下链接访问您的空间：`,
    expires: '此链接将在 {minutes} 分钟后过期，且只能使用一次。',
    ignore: '如果您没有发起此请求，请忽略此邮件。',
  },
  hi: {
    subject: 'आपका सुरक्षित साइन-इन लिंक',
    greeting: 'नमस्ते,',
    body: `आपने ${APP_NAME} में साइन इन करने का अनुरोध किया है। अपने स्पेस तक पहुँचने के लिए नीचे दिए गए लिंक पर क्लिक करें:`,
    expires: 'यह लिंक {minutes} मिनट में समाप्त हो जाएगा और केवल एक बार उपयोग किया जा सकता है।',
    ignore: 'यदि आपने यह अनुरोध नहीं किया है, तो कृपया इस ईमेल को अनदेखा करें।',
  },
  ar: {
    subject: 'رابط تسجيل الدخول الآمن الخاص بك',
    greeting: 'مرحبًا،',
    body: `لقد طلبت تسجيل الدخول إلى ${APP_NAME}. انقر على الرابط أدناه للوصول إلى مساحتك:`,
    expires: 'تنتهي صلاحية هذا الرابط خلال {minutes} دقيقة ولا يمكن استخدامه إلا مرة واحدة.',
    ignore: 'إذا لم تكن أنت من أرسل هذا الطلب، يرجى تجاهل هذا البريد الإلكتروني.',
  },
  bn: {
    subject: 'আপনার নিরাপদ সাইন-ইন লিঙ্ক',
    greeting: 'হ্যালো,',
    body: `আপনি ${APP_NAME}-এ সাইন ইন করার অনুরোধ করেছেন। আপনার স্পেসে প্রবেশ করতে নিচের লিঙ্কে ক্লিক করুন:`,
    expires: 'এই লিঙ্কটি {minutes} মিনিটে মেয়াদ শেষ হবে এবং শুধুমাত্র একবার ব্যবহার করা যাবে।',
    ignore: 'আপনি এই অনুরোধ না করলে, এই ইমেলটি উপেক্ষা করুন।',
  },
};

type EmailCopyEntry = {
  subject: string;
  greeting: string;
  body: string;
  expires: string;
  ignore: string;
};

const EMAIL_CHANGE_COPY: Record<SupportedLanguage, EmailCopyEntry> = {
  en: {
    subject: 'Confirm your new email address',
    greeting: 'Hello,',
    body: `You requested to change your email address on ${APP_NAME}. Click the link below to confirm:`,
    expires: 'This link expires in {minutes} minutes and can only be used once.',
    ignore: 'If you did not request this, please ignore this email.',
  },
  fr: {
    subject: 'Confirmez votre nouvelle adresse email',
    greeting: 'Bonjour,',
    body: `Vous avez demandé à changer votre adresse email sur ${APP_NAME}. Cliquez sur le lien ci-dessous pour confirmer :`,
    expires: 'Ce lien expire dans {minutes} minutes et ne peut être utilisé qu\u2019une seule fois.',
    ignore: 'Si vous n\u2019êtes pas à l\u2019origine de cette demande, ignorez cet email.',
  },
  de: {
    subject: 'Bestätigen Sie Ihre neue E-Mail-Adresse',
    greeting: 'Hallo,',
    body: `Sie haben eine Änderung Ihrer E-Mail-Adresse bei ${APP_NAME} angefordert. Klicken Sie auf den folgenden Link zur Bestätigung:`,
    expires: 'Dieser Link läuft in {minutes} Minuten ab und kann nur einmal verwendet werden.',
    ignore: 'Wenn Sie diese Anfrage nicht gestellt haben, ignorieren Sie bitte diese E-Mail.',
  },
  es: {
    subject: 'Confirma tu nueva dirección de correo',
    greeting: 'Hola,',
    body: `Has solicitado cambiar tu dirección de correo en ${APP_NAME}. Haz clic en el enlace de abajo para confirmar:`,
    expires: 'Este enlace caduca en {minutes} minutos y solo puede usarse una vez.',
    ignore: 'Si no has solicitado esto, ignora este correo.',
  },
  it: {
    subject: 'Conferma il tuo nuovo indirizzo email',
    greeting: 'Ciao,',
    body: `Hai richiesto di cambiare il tuo indirizzo email su ${APP_NAME}. Clicca sul link qui sotto per confermare:`,
    expires: 'Questo link scade tra {minutes} minuti e può essere usato una sola volta.',
    ignore: 'Se non hai effettuato questa richiesta, ignora questa email.',
  },
  pt: {
    subject: 'Confirme seu novo endereço de email',
    greeting: 'Olá,',
    body: `Você solicitou a alteração do seu endereço de email no ${APP_NAME}. Clique no link abaixo para confirmar:`,
    expires: 'Este link expira em {minutes} minutos e só pode ser usado uma vez.',
    ignore: 'Se você não fez esta solicitação, ignore este email.',
  },
  nl: {
    subject: 'Bevestig uw nieuwe e-mailadres',
    greeting: 'Hallo,',
    body: `U heeft een wijziging van uw e-mailadres bij ${APP_NAME} aangevraagd. Klik op de onderstaande link om te bevestigen:`,
    expires: 'Deze link verloopt over {minutes} minuten en kan slechts één keer worden gebruikt.',
    ignore: 'Als u dit niet heeft aangevraagd, kunt u deze e-mail negeren.',
  },
  pl: {
    subject: 'Potwierdź swój nowy adres e-mail',
    greeting: 'Cześć,',
    body: `Poprosiłeś o zmianę adresu e-mail w ${APP_NAME}. Kliknij poniższy link, aby potwierdzić:`,
    expires: 'Ten link wygasa za {minutes} minut i może być użyty tylko raz.',
    ignore: 'Jeśli nie wysłałeś tego żądania, zignoruj tego e-maila.',
  },
  ru: {
    subject: 'Подтвердите ваш новый адрес электронной почты',
    greeting: 'Здравствуйте,',
    body: `Вы запросили изменение адреса электронной почты в ${APP_NAME}. Нажмите на ссылку ниже для подтверждения:`,
    expires: 'Эта ссылка истекает через {minutes} минут и может быть использована только один раз.',
    ignore: 'Если вы не отправляли этот запрос, проигнорируйте это письмо.',
  },
  uk: {
    subject: 'Підтвердіть вашу нову адресу електронної пошти',
    greeting: 'Вітаємо,',
    body: `Ви запросили зміну адреси електронної пошти в ${APP_NAME}. Натисніть на посилання нижче для підтвердження:`,
    expires: 'Це посилання дійсне {minutes} хвилин і може бути використане лише один раз.',
    ignore: 'Якщо ви не надсилали цей запит, проігноруйте цей лист.',
  },
  zh: {
    subject: '确认您的新电子邮件地址',
    greeting: '您好，',
    body: `您请求更改在 ${APP_NAME} 上的电子邮件地址。请点击以下链接确认：`,
    expires: '此链接将在 {minutes} 分钟后过期，且只能使用一次。',
    ignore: '如果您没有发起此请求，请忽略此邮件。',
  },
  hi: {
    subject: 'अपना नया ईमेल पता पुष्टि करें',
    greeting: 'नमस्ते,',
    body: `आपने ${APP_NAME} पर अपना ईमेल पता बदलने का अनुरोध किया है। पुष्टि करने के लिए नीचे दिए गए लिंक पर क्लिक करें:`,
    expires: 'यह लिंक {minutes} मिनट में समाप्त हो जाएगा और केवल एक बार उपयोग किया जा सकता है।',
    ignore: 'यदि आपने यह अनुरोध नहीं किया है, तो कृपया इस ईमेल को अनदेखा करें।',
  },
  ar: {
    subject: 'تأكيد عنوان بريدك الإلكتروني الجديد',
    greeting: 'مرحبًا،',
    body: `لقد طلبت تغيير عنوان بريدك الإلكتروني في ${APP_NAME}. انقر على الرابط أدناه للتأكيد:`,
    expires: 'تنتهي صلاحية هذا الرابط خلال {minutes} دقيقة ولا يمكن استخدامه إلا مرة واحدة.',
    ignore: 'إذا لم تكن أنت من أرسل هذا الطلب، يرجى تجاهل هذا البريد الإلكتروني.',
  },
  bn: {
    subject: 'আপনার নতুন ইমেল ঠিকানা নিশ্চিত করুন',
    greeting: 'হ্যালো,',
    body: `আপনি ${APP_NAME}-এ আপনার ইমেল ঠিকানা পরিবর্তনের অনুরোধ করেছেন। নিশ্চিত করতে নিচের লিঙ্কে ক্লিক করুন:`,
    expires: 'এই লিঙ্কটি {minutes} মিনিটে মেয়াদ শেষ হবে এবং শুধুমাত্র একবার ব্যবহার করা যাবে।',
    ignore: 'আপনি এই অনুরোধ না করলে, এই ইমেলটি উপেক্ষা করুন।',
  },
};

const EMAIL_CHANGED_NOTICE_COPY: Record<SupportedLanguage, {
  subject: string;
  body: string;
}> = {
  en: {
    subject: 'Your email address was changed',
    body: `The email address of your ${APP_NAME} account has just been changed. If you did not request this change, please contact support immediately.`,
  },
  fr: {
    subject: 'Votre adresse email a été modifiée',
    body: `L’adresse email de votre compte ${APP_NAME} vient d’être modifiée. Si vous n’êtes pas à l’origine de ce changement, contactez immédiatement le support.`,
  },
  de: {
    subject: 'Ihre E-Mail-Adresse wurde geändert',
    body: `Die E-Mail-Adresse Ihres ${APP_NAME}-Kontos wurde soeben geändert. Wenn Sie diese Änderung nicht angefordert haben, kontaktieren Sie bitte umgehend den Support.`,
  },
  es: {
    subject: 'Tu dirección de correo ha sido cambiada',
    body: `La dirección de correo de tu cuenta de ${APP_NAME} acaba de ser cambiada. Si no has solicitado este cambio, contacta con el soporte inmediatamente.`,
  },
  it: {
    subject: 'Il tuo indirizzo email è stato modificato',
    body: `L'indirizzo email del tuo account ${APP_NAME} è appena stato modificato. Se non hai richiesto questa modifica, contatta subito il supporto.`,
  },
  pt: {
    subject: 'Seu endereço de email foi alterado',
    body: `O endereço de email da sua conta ${APP_NAME} acabou de ser alterado. Se você não solicitou esta alteração, contate o suporte imediatamente.`,
  },
  nl: {
    subject: 'Uw e-mailadres is gewijzigd',
    body: `Het e-mailadres van uw ${APP_NAME}-account is zojuist gewijzigd. Als u deze wijziging niet heeft aangevraagd, neem dan onmiddellijk contact op met de support.`,
  },
  pl: {
    subject: 'Twój adres e-mail został zmieniony',
    body: `Adres e-mail Twojego konta ${APP_NAME} został właśnie zmieniony. Jeśli nie prosiłeś o tę zmianę, natychmiast skontaktuj się z pomocą techniczną.`,
  },
  ru: {
    subject: 'Ваш адрес электронной почты был изменён',
    body: `Адрес электронной почты вашей учётной записи ${APP_NAME} только что был изменён. Если вы не запрашивали это изменение, немедленно свяжитесь со службой поддержки.`,
  },
  uk: {
    subject: 'Вашу адресу електронної пошти було змінено',
    body: `Адресу електронної пошти вашого облікового запису ${APP_NAME} щойно було змінено. Якщо ви не запитували цю зміну, негайно зверніться до служби підтримки.`,
  },
  zh: {
    subject: '您的电子邮件地址已被更改',
    body: `您的 ${APP_NAME} 账户的电子邮件地址刚刚被更改。如果您没有请求此更改，请立即联系支持团队。`,
  },
  hi: {
    subject: 'आपका ईमेल पता बदल दिया गया है',
    body: `आपके ${APP_NAME} खाते का ईमेल पता अभी बदला गया है। यदि आपने यह परिवर्तन नहीं किया है, तो कृपया तुरंत सहायता टीम से संपर्क करें।`,
  },
  ar: {
    subject: 'تم تغيير عنوان بريدك الإلكتروني',
    body: `تم للتو تغيير عنوان البريد الإلكتروني لحسابك في ${APP_NAME}. إذا لم تطلب هذا التغيير، يرجى التواصل مع الدعم فورًا.`,
  },
  bn: {
    subject: 'আপনার ইমেল ঠিকানা পরিবর্তন করা হয়েছে',
    body: `আপনার ${APP_NAME} অ্যাকাউন্টের ইমেল ঠিকানা এইমাত্র পরিবর্তন করা হয়েছে। আপনি এই পরিবর্তনের অনুরোধ না করলে, অবিলম্বে সাপোর্টের সাথে যোগাযোগ করুন।`,
  },
};

function resolveLanguage(lang?: string): SupportedLanguage {
  if (!lang) return 'en';
  const base = lang.toLowerCase().split('-')[0];
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(base)) {
    return base as SupportedLanguage;
  }
  return 'en';
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildEmail(params: SendMagicLinkParams) {
  const lang = resolveLanguage(params.language);
  const copy = EMAIL_COPY[lang];
  const expires = copy.expires.replace('{minutes}', String(params.expiresInMinutes));

  return {
    subject: copy.subject,
    text: [copy.greeting, '', copy.body, '', params.link, '', expires, '', copy.ignore].join('\n'),
    html: [
      `<p>${escapeHtml(copy.greeting)}</p>`,
      `<p>${escapeHtml(copy.body)}</p>`,
      `<p><a href="${escapeHtml(params.link)}">${escapeHtml(params.link)}</a></p>`,
      `<p>${escapeHtml(expires)}</p>`,
      `<p style="color:#888;font-size:0.9em">${escapeHtml(copy.ignore)}</p>`,
    ].join(''),
  };
}

// --- Resend (HTTPS API) ---

function isResendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

interface EmailPayload {
  to: string;
  subject: string;
  text: string;
  html: string;
}

async function sendViaResend(payload: EmailPayload): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY!;
  const from = process.env.MAIL_FROM!;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [payload.to],
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

// --- SMTP (nodemailer) ---

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

function getSmtpConfig(): SmtpConfig {
  const host = process.env.SMTP_HOST || '';
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = (process.env.SMTP_SECURE || 'true').toLowerCase() !== 'false';
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  const from = process.env.MAIL_FROM || user;

  if (!host || !user || !pass || !from || Number.isNaN(port)) {
    throw new Error('SMTP configuration is incomplete');
  }

  return { host, port, secure, user, pass, from };
}

function isSmtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let cachedTransporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!cachedTransporter) {
    const config = getSmtpConfig();
    cachedTransporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.pass },
      pool: true,
      maxConnections: 3,
    });
  }
  return cachedTransporter;
}

async function sendViaSmtp(payload: EmailPayload): Promise<void> {
  const config = getSmtpConfig();
  const transporter = getTransporter();

  await transporter.sendMail({
    from: config.from,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
  });
}

async function sendEmail(payload: EmailPayload): Promise<void> {
  if (isResendConfigured()) {
    await sendViaResend(payload);
  } else if (isSmtpConfigured()) {
    await sendViaSmtp(payload);
  } else {
    throw new Error('No email provider configured (set RESEND_API_KEY or SMTP_HOST)');
  }
}

// --- Public API ---

export function isMailerConfigured(): boolean {
  return isResendConfigured() || isSmtpConfigured();
}

export async function sendMagicLinkEmail(params: SendMagicLinkParams): Promise<void> {
  const email = buildEmail(params);
  await sendEmail({ to: params.to, ...email });
}

export interface SendEmailChangeParams {
  to: string;
  link: string;
  expiresInMinutes: number;
  language?: string;
}

export interface SendEmailChangedNoticeParams {
  to: string;
  language?: string;
}

// Notify the previous address after an email change has been confirmed
export async function sendEmailChangedNotice(params: SendEmailChangedNoticeParams): Promise<void> {
  const lang = resolveLanguage(params.language);
  const copy = EMAIL_CHANGED_NOTICE_COPY[lang];

  await sendEmail({
    to: params.to,
    subject: copy.subject,
    text: copy.body,
    html: `<p>${escapeHtml(copy.body)}</p>`,
  });
}

export async function sendEmailChangeVerification(params: SendEmailChangeParams): Promise<void> {
  const lang = resolveLanguage(params.language);
  const copy = EMAIL_CHANGE_COPY[lang];
  const expires = copy.expires.replace('{minutes}', String(params.expiresInMinutes));

  const email = {
    subject: copy.subject,
    text: [copy.greeting, '', copy.body, '', params.link, '', expires, '', copy.ignore].join('\n'),
    html: [
      `<p>${escapeHtml(copy.greeting)}</p>`,
      `<p>${escapeHtml(copy.body)}</p>`,
      `<p><a href="${escapeHtml(params.link)}">${escapeHtml(params.link)}</a></p>`,
      `<p>${escapeHtml(expires)}</p>`,
      `<p style="color:#888;font-size:0.9em">${escapeHtml(copy.ignore)}</p>`,
    ].join(''),
  };

  await sendEmail({ to: params.to, ...email });
}
