import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'leaflet/dist/leaflet.css';
import './style.css';
import App from './ui/App';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Could not find the app root element.');

createRoot(rootElement).render(<StrictMode><App /></StrictMode>);
