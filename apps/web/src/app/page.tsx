import { redirect } from 'next/navigation';

export default function Home() {
  // Redirect visitors to the Login page immediately
  redirect('/auth/login');
}
