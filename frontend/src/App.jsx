import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './App.css'
import HomePage from './pages/HomePage'
import TestPage from './pages/TestPage'
import TrackOcrResultsPage from './pages/TrackOcrResultsPage'
import NumberOcrTestPage from './pages/NumberOcrTestPage'
import LoginPage from './pages/LoginPage'
import SettingsPage from './pages/SettingsPage'
import AdminPage from './pages/AdminPage'
import OfficialCollectPage from './pages/OfficialCollectPage'
import DataCollectPage from './pages/DataCollectPage'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/data-collect" element={<DataCollectPage />} />
        <Route path="/test" element={<TestPage />} />
        <Route path="/track-ocr-results" element={<TrackOcrResultsPage />} />
        <Route path="/number-ocr-test" element={<NumberOcrTestPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/collect" element={<OfficialCollectPage />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
