'use client';

import { FormEvent, useState } from 'react';

type ContactFormCopy = {
  title: string;
  subtitle: string;
  checklistTitle: string;
  checklist: string[];
  name: string;
  company: string;
  email: string;
  message: string;
  submit: string;
  note: string;
};

type ContactFormProps = {
  form: ContactFormCopy;
  locale: 'en' | 'fi';
  titleLevel: 'h2' | 'h3';
};

const messages = {
  en: {
    sending: 'Sending...',
    success: 'Thank you. Your project inquiry has been sent.',
    error: 'Unable to send the message right now. Please email projects@titanorgroup.fi.'
  },
  fi: {
    sending: 'Lähetetään...',
    success: 'Kiitos. Projektikyselysi on lähetetty.',
    error: 'Viestin lähetys ei juuri nyt onnistunut. Lähetä sähköpostia osoitteeseen projects@titanorgroup.fi.'
  }
};

export function ContactForm({ form, locale, titleLevel }: ContactFormProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const Title = titleLevel;
  const copy = messages[locale];

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const formElement = event.currentTarget;
    const formData = new FormData(formElement);

    setIsLoading(true);
    setStatus('');
    setError('');

    try {
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: formData.get('name'),
          company: formData.get('company'),
          email: formData.get('email'),
          message: formData.get('message'),
          website: formData.get('website')
        })
      });

      const result = (await response.json().catch(() => null)) as { ok?: boolean } | null;

      if (!response.ok || !result?.ok) {
        throw new Error('Contact request failed');
      }

      formElement.reset();
      setStatus(copy.success);
    } catch {
      setError(copy.error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form className="contact-form" onSubmit={onSubmit}>
      <Title className="form-title">{form.title}</Title>
      <p className="form-subtitle">{form.subtitle}</p>
      <p className="form-checklist-title">{form.checklistTitle}</p>

      <ul className="form-checklist">
        {form.checklist.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>

      <label>
        <span>{form.name}</span>
        <input name="name" type="text" placeholder={form.name} required />
      </label>

      <label>
        <span>{form.company}</span>
        <input name="company" type="text" placeholder={form.company} />
      </label>

      <label>
        <span>{form.email}</span>
        <input name="email" type="email" placeholder={form.email} required />
      </label>

      <label>
        <span>{form.message}</span>
        <textarea name="message" placeholder={form.message} required />
      </label>

      <label style={{ display: 'none' }} aria-hidden="true">
        <span>Website</span>
        <input name="website" type="text" tabIndex={-1} autoComplete="off" />
      </label>

      <button className="button-primary form-button" type="submit" disabled={isLoading}>
        {isLoading ? copy.sending : form.submit}
      </button>

      {status ? (
        <p className="form-note" role="status" aria-live="polite">
          {status}
        </p>
      ) : null}

      {error ? (
        <p className="admin-form-error" role="alert">
          {error}
        </p>
      ) : null}

      <p className="form-note">{form.note}</p>
    </form>
  );
}
