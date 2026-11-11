import '@fontsource-variable/public-sans';
import '@fontsource/jetbrains-mono/400.css';
import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Rail } from '@/components/rail';

export const metadata: Metadata = {
  title: { default: 'Software factory', template: '%s | Software factory' },
  description: 'What the software factory did, why, and the record that proves it.',
  robots: { index: false },
};

// Every page reads the live record.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Rail />
        <main>{children}</main>
      </body>
    </html>
  );
}
