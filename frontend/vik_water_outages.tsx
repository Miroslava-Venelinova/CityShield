import React, { useState, useEffect, useRef } from 'react';
import { 
  Shield, LogIn, Mail, Lock, Eye, EyeOff, User, Settings, MessageCircle,
  MapPin, Menu, X, ChevronRight, ChevronLeft, Bell, Accessibility, Bot,
  Camera, Sun, Moon, Zap, Clock, Volume2, Trash2, Key, Globe, Palette,
  Search, Droplet, AlertCircle, Calendar, Filter, RefreshCw
} from 'lucide-react';

export default function CityShield() {
  const [screen, setScreen] = useState('loading');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isSignUp, setIsSignUp] = useState(false);
  const [menuOpen, setMenuOpen] = useState(null);
  const [theme, setTheme] = useState('light');
  const [fontSize, setFontSize] = useState('medium');
  const [mapStyle, setMapStyle] = useState('day');
  const [bottomSheetHeight, setBottomSheetHeight] = useState(50); // percentage
  const [isDragging, setIsDragging] = useState(false);
  const [startY, setStartY] = useState(0);
  const [startHeight, setStartHeight] = useState(0);
  
  // Form states
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [agreeTerms, setAgreeTerms] = useState(false);
  
  // User data
  const [userData, setUserData] = useState({
    name: 'Иван Петров',
    email: 'ivan@example.com',
    bio: 'Живея в кв. Аспарухово',
    phone: '+359 888 123 456'
  });
  
  // Settings
  const [settings, setSettings] = useState({
    highContrast: false,
    textSize: 'medium',
    reduceMotion: false,
    notificationsEnabled: true,
    notificationFrequency: 'realtime',
    quietHoursStart: '22:00',
    quietHoursEnd: '07:00'
  });

  // Water outage messages
  const [messages, setMessages] = useState([]);
  const [filteredMessages, setFilteredMessages] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedLocation, setSelectedLocation] = useState('all');

  useEffect(() => {
    // Check authentication
    const auth = localStorage.getItem('cityshield_auth');
    if (auth) {
      setIsAuthenticated(true);
    }
    
    // Show loading screen
    const timer = setTimeout(() => {
      if (auth) {
        setScreen('main');
        loadMessages();
      } else {
        setScreen('login');
      }
    }, 2500);
    
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (screen === 'main') {
      loadMessages();
    }
  }, [screen]);

  useEffect(() => {
    filterMessages();
  }, [searchQuery, selectedLocation, messages]);

  const loadMessages = () => {
    const sampleData = [
      {
        id: 16186,
        date: "10.01.2026",
        message: 'Поради предизвикана аватия от частна фирма на ул. "13-та", без вода ще бъдат абонатите от висока зона на м-т "Евксиноград" и м-т "Малко Ю" от 10:30 до 17:00 ч.',
        parsed: { locations: ["Евксиноград", "Малко Ю"], start_time: "10:30", end_time: "17:00" },
        coords: [43.2167, 27.9167]
      },
      {
        id: 16185,
        date: "09.01.2026",
        message: 'Поради авария на водопровод на бул. "Владислав Варненчик", без вода ще бъдат абонатите в района на кв. "Аспарухово" от 14:00 до 18:30 ч.',
        parsed: { locations: ["Аспарухово"], start_time: "14:00", end_time: "18:30" },
        coords: [43.1833, 27.8833]
      }
    ];
    setMessages(sampleData);
  };

  const filterMessages = () => {
    let filtered = messages;
    if (searchQuery) {
      filtered = filtered.filter(msg => 
        msg.message.toLowerCase().includes(searchQuery.toLowerCase()) ||
        msg.parsed?.locations?.some(loc => loc.toLowerCase().includes(searchQuery.toLowerCase()))
      );
    }
    if (selectedLocation !== 'all') {
      filtered = filtered.filter(msg =>
        msg.parsed?.locations?.some(loc => loc === selectedLocation)
      );
    }
    setFilteredMessages(filtered);
  };

  const getAllLocations = () => {
    const locations = new Set();
    messages.forEach(msg => {
      msg.parsed?.locations?.forEach(loc => locations.add(loc));
    });
    return Array.from(locations).sort();
  };

  const handleDragStart = (e) => {
    setIsDragging(true);
    const clientY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
    setStartY(clientY);
    setStartHeight(bottomSheetHeight);
  };

  const handleDragMove = (e) => {
    if (!isDragging) return;
    
    const clientY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
    const deltaY = startY - clientY;
    const viewportHeight = window.innerHeight;
    const deltaPercent = (deltaY / viewportHeight) * 100;
    
    let newHeight = startHeight + deltaPercent;
    newHeight = Math.max(10, Math.min(90, newHeight)); // Min 10%, Max 90%
    
    setBottomSheetHeight(newHeight);
  };

  const handleDragEnd = () => {
    setIsDragging(false);
    
    // Snap to positions
    if (bottomSheetHeight < 25) {
      setBottomSheetHeight(10); // Minimized
    } else if (bottomSheetHeight < 60) {
      setBottomSheetHeight(50); // Medium
    } else {
      setBottomSheetHeight(85); // Maximized
    }
  };

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleDragMove);
      window.addEventListener('mouseup', handleDragEnd);
      window.addEventListener('touchmove', handleDragMove);
      window.addEventListener('touchend', handleDragEnd);
      
      return () => {
        window.removeEventListener('mousemove', handleDragMove);
        window.removeEventListener('mouseup', handleDragEnd);
        window.removeEventListener('touchmove', handleDragMove);
        window.removeEventListener('touchend', handleDragEnd);
      };
    }
  }, [isDragging, startY, startHeight, bottomSheetHeight]);


  const getPasswordStrength = (pwd) => {
    if (!pwd) return 0;
    let strength = 0;
    if (pwd.length >= 8) strength++;
    if (/[a-z]/.test(pwd) && /[A-Z]/.test(pwd)) strength++;
    if (/\d/.test(pwd)) strength++;
    if (/[^a-zA-Z\d]/.test(pwd)) strength++;
    return strength;
  };

  const handleLogin = (e) => {
    e.preventDefault();
    if (email && password) {
      localStorage.setItem('cityshield_auth', 'true');
      setIsAuthenticated(true);
      setScreen('main');
    }
  };

  const handleSignUp = (e) => {
    e.preventDefault();
    if (email && password && password === confirmPassword && agreeTerms) {
      localStorage.setItem('cityshield_auth', 'true');
      setIsAuthenticated(true);
      setScreen('main');
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('cityshield_auth');
    setIsAuthenticated(false);
    setScreen('login');
    setMenuOpen(null);
  };

  const passwordStrength = getPasswordStrength(password);
  const strengthLabels = ['', 'Слаба', 'Средна', 'Добра', 'Отлична'];
  const strengthColors = ['', 'bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-green-500'];

  // Loading Screen
  if (screen === 'loading') {
    return (
      <div className="fixed inset-0 bg-gradient-to-br from-blue-600 via-blue-700 to-blue-800 flex items-center justify-center">
        <div className="text-center animate-fade-in">
          <div className="relative mb-8">
            <div className="absolute inset-0 bg-white/20 rounded-full blur-3xl animate-pulse"></div>
            <Shield className="w-32 h-32 text-white relative animate-bounce-slow mx-auto" />
          </div>
          <h1 className="text-5xl font-bold text-white mb-4 animate-slide-up">CityShield</h1>
          <p className="text-blue-100 text-lg animate-slide-up-delay">Защитаваме вашия град</p>
          <div className="mt-8 flex justify-center gap-2">
            <div className="w-2 h-2 bg-white rounded-full animate-bounce" style={{animationDelay: '0ms'}}></div>
            <div className="w-2 h-2 bg-white rounded-full animate-bounce" style={{animationDelay: '150ms'}}></div>
            <div className="w-2 h-2 bg-white rounded-full animate-bounce" style={{animationDelay: '300ms'}}></div>
          </div>
        </div>
      </div>
    );
  }

  // Login/Signup Screen
  if (screen === 'login' || screen === 'signup') {
    return (
      <div className={`min-h-screen ${theme === 'dark' ? 'bg-gray-900' : 'bg-gradient-to-br from-blue-50 to-cyan-50'}`}>
        <div className="min-h-screen flex flex-col">
          {/* Header */}
          <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white px-6 py-8">
            <div className="flex items-center gap-3 mb-2">
              <Shield className="w-12 h-12" />
              <div>
                <h1 className="text-3xl font-bold">CityShield</h1>
                <p className="text-blue-100 text-sm">Варна • Водоснабдяване</p>
              </div>
            </div>
          </div>

          {/* Form Container */}
          <div className="flex-1 px-6 py-8">
            <div className="max-w-md mx-auto">
              <h2 className={`text-2xl font-bold mb-6 ${theme === 'dark' ? 'text-white' : 'text-gray-800'}`}>
                {isSignUp ? 'Регистрация' : 'Вход'}
              </h2>

              <form onSubmit={isSignUp ? handleSignUp : handleLogin} className="space-y-4">
                {/* Email */}
                <div>
                  <label className={`block text-sm font-medium mb-2 ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>
                    Имейл
                  </label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="ivan@example.com"
                      required
                    />
                  </div>
                </div>

                {/* Password */}
                <div>
                  <label className={`block text-sm font-medium mb-2 ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>
                    Парола
                  </label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full pl-10 pr-12 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="••••••••"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400"
                    >
                      {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                    </button>
                  </div>
                  
                  {isSignUp && password && (
                    <div className="mt-2">
                      <div className="flex gap-1 mb-1">
                        {[1, 2, 3, 4].map((i) => (
                          <div
                            key={i}
                            className={`h-1 flex-1 rounded ${i <= passwordStrength ? strengthColors[passwordStrength] : 'bg-gray-200'}`}
                          ></div>
                        ))}
                      </div>
                      <p className="text-xs text-gray-600">{strengthLabels[passwordStrength]}</p>
                    </div>
                  )}
                </div>

                {/* Confirm Password (Signup only) */}
                {isSignUp && (
                  <div>
                    <label className={`block text-sm font-medium mb-2 ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>
                      Потвърди парола
                    </label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                      <input
                        type={showConfirmPassword ? 'text' : 'password'}
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        className="w-full pl-10 pr-12 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        placeholder="••••••••"
                        required
                      />
                      <button
                        type="button"
                        onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                        className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400"
                      >
                        {showConfirmPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                      </button>
                    </div>
                    {confirmPassword && password !== confirmPassword && (
                      <p className="text-xs text-red-500 mt-1">Паролите не съвпадат</p>
                    )}
                  </div>
                )}

                {/* Remember Me / Terms */}
                <div className="flex items-center gap-2">
                  {isSignUp ? (
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={agreeTerms}
                        onChange={(e) => setAgreeTerms(e.target.checked)}
                        className="w-4 h-4 text-blue-600 rounded"
                        required
                      />
                      <span className="text-sm text-gray-600">
                        Съгласен съм с <a href="#" className="text-blue-600">условията за ползване</a>
                      </span>
                    </label>
                  ) : (
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={rememberMe}
                        onChange={(e) => setRememberMe(e.target.checked)}
                        className="w-4 h-4 text-blue-600 rounded"
                      />
                      <span className="text-sm text-gray-600">Запомни ме</span>
                    </label>
                  )}
                </div>

                {/* Submit Button */}
                <button
                  type="submit"
                  className="w-full bg-gradient-to-r from-blue-600 to-blue-700 text-white py-3 rounded-xl font-semibold hover:from-blue-700 hover:to-blue-800 transition-all shadow-lg"
                >
                  {isSignUp ? 'Регистрация' : 'Вход'}
                </button>

                {/* Forgot Password */}
                {!isSignUp && (
                  <div className="text-center">
                    <a href="#" className="text-sm text-blue-600 hover:underline">
                      Забравена парола?
                    </a>
                  </div>
                )}

                {/* Toggle Login/Signup */}
                <div className="text-center pt-4 border-t">
                  <button
                    type="button"
                    onClick={() => setIsSignUp(!isSignUp)}
                    className="text-sm text-blue-600 hover:underline"
                  >
                    {isSignUp ? 'Вече имате акаунт? Влезте' : 'Нямате акаунт? Регистрирайте се'}
                  </button>
                </div>

                {/* Social Login */}
                <div className="pt-4">
                  <p className="text-center text-sm text-gray-500 mb-4">Или продължете с</p>
                  <div className="grid grid-cols-3 gap-3">
                    <button 
                      type="button" 
                      onClick={() => {
                        localStorage.setItem('cityshield_auth', 'true');
                        setIsAuthenticated(true);
                        setScreen('main');
                      }}
                      className="py-3 border border-gray-300 rounded-xl hover:bg-gray-50 transition-colors"
                    >
                      <span className="text-sm font-medium">Google</span>
                    </button>
                    <button 
                      type="button"
                      onClick={() => {
                        localStorage.setItem('cityshield_auth', 'true');
                        setIsAuthenticated(true);
                        setScreen('main');
                      }}
                      className="py-3 border border-gray-300 rounded-xl hover:bg-gray-50 transition-colors"
                    >
                      <span className="text-sm font-medium">Apple</span>
                    </button>
                    <button 
                      type="button"
                      onClick={() => {
                        localStorage.setItem('cityshield_auth', 'true');
                        setIsAuthenticated(true);
                        setScreen('main');
                      }}
                      className="py-3 border border-gray-300 rounded-xl hover:bg-gray-50 transition-colors"
                    >
                      <span className="text-sm font-medium">FB</span>
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Main Screen with Map
  if (screen === 'main') {
    return (
      <div className={`min-h-screen ${theme === 'dark' ? 'bg-gray-900' : 'bg-gray-50'}`}>
        {/* Map Container */}
        <div className="relative h-screen">
          {/* Map Placeholder */}
          <div className={`absolute inset-0 ${mapStyle === 'night' ? 'bg-gray-800' : mapStyle === 'satellite' ? 'bg-gray-700' : 'bg-blue-100'}`}>
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center">
                <MapPin className={`w-16 h-16 mx-auto mb-4 ${mapStyle === 'night' ? 'text-gray-600' : 'text-blue-400'}`} />
                <p className={`${mapStyle === 'night' ? 'text-gray-400' : 'text-gray-600'}`}>
                  Интерактивна карта на Варна
                </p>
                <p className={`text-sm mt-2 ${mapStyle === 'night' ? 'text-gray-500' : 'text-gray-500'}`}>
                  {messages.length} активни известия
                </p>
              </div>
            </div>
            
            {/* Map Markers */}
            {messages.map((msg, idx) => (
              <div
                key={msg.id}
                className="absolute"
                style={{
                  left: `${30 + idx * 20}%`,
                  top: `${40 + idx * 10}%`,
                }}
              >
                <div className="relative">
                  <Droplet className="w-8 h-8 text-red-500 animate-bounce" />
                  <div className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full animate-ping"></div>
                </div>
              </div>
            ))}
          </div>

          {/* Top Left - Settings */}
          <button
            onClick={() => setMenuOpen('settings')}
            className="absolute top-4 left-4 p-3 bg-white rounded-full shadow-lg hover:shadow-xl transition-shadow z-10"
            aria-label="Settings"
          >
            <Settings className="w-6 h-6 text-gray-700" />
          </button>

          {/* Top Right - Profile */}
          <button
            onClick={() => setMenuOpen('profile')}
            className="absolute top-4 right-4 p-3 bg-white rounded-full shadow-lg hover:shadow-xl transition-shadow z-10"
            aria-label="Profile"
          >
            <User className="w-6 h-6 text-gray-700" />
          </button>

          {/* Bottom Right - Chat */}
          <button
            onClick={() => setMenuOpen('chat')}
            className="absolute bottom-24 right-4 p-4 bg-gradient-to-r from-blue-600 to-blue-700 rounded-full shadow-lg hover:shadow-xl transition-shadow z-10"
            aria-label="Chat"
          >
            <MessageCircle className="w-6 h-6 text-white" />
          </button>

          {/* Map Style Selector */}
          <div className="absolute top-20 left-4 bg-white rounded-xl shadow-lg p-2 space-y-2 z-10">
            <button
              onClick={() => setMapStyle('day')}
              className={`w-full px-4 py-2 rounded-lg text-sm font-medium transition-colors ${mapStyle === 'day' ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`}
            >
              <Sun className="w-4 h-4 inline mr-2" />
              Ден
            </button>
            <button
              onClick={() => setMapStyle('night')}
              className={`w-full px-4 py-2 rounded-lg text-sm font-medium transition-colors ${mapStyle === 'night' ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`}
            >
              <Moon className="w-4 h-4 inline mr-2" />
              Нощ
            </button>
            <button
              onClick={() => setMapStyle('satellite')}
              className={`w-full px-4 py-2 rounded-lg text-sm font-medium transition-colors ${mapStyle === 'satellite' ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'}`}
            >
              <Globe className="w-4 h-4 inline mr-2" />
              Сателит
            </button>
          </div>

          {/* Bottom Sheet - Messages */}
          <div 
            className="absolute bottom-0 left-0 right-0 bg-white rounded-t-3xl shadow-2xl z-20 transition-all"
            style={{ 
              height: `${bottomSheetHeight}vh`,
              touchAction: 'none'
            }}
          >
            <div className="h-full flex flex-col">
              {/* Drag Handle */}
              <div 
                className="px-4 py-3 cursor-grab active:cursor-grabbing"
                onMouseDown={handleDragStart}
                onTouchStart={handleDragStart}
              >
                <div className="w-12 h-1 bg-gray-300 rounded-full mx-auto"></div>
              </div>

              {/* Content */}
              <div className="flex-1 overflow-hidden flex flex-col px-4 pb-4">
                {/* Search */}
                {bottomSheetHeight > 20 && (
                  <div className="relative mb-4">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                    <input
                      type="text"
                      placeholder="Търси район..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                    />
                  </div>
                )}

                {/* Messages List */}
                {bottomSheetHeight > 20 && (
                  <div className="flex-1 overflow-y-auto space-y-3">
                    {filteredMessages.length > 0 ? filteredMessages.map((msg) => (
                      <div key={msg.id} className="bg-blue-50 rounded-xl p-3">
                        <div className="flex items-start gap-3">
                          <Droplet className="w-5 h-5 text-blue-600 flex-shrink-0 mt-1" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              {msg.parsed?.locations?.map((loc, idx) => (
                                <span key={idx} className="px-2 py-0.5 bg-blue-600 text-white text-xs rounded-full">
                                  {loc}
                                </span>
                              ))}
                            </div>
                            <p className="text-sm text-gray-700 line-clamp-2">{msg.message}</p>
                            {msg.parsed?.start_time && (
                              <p className="text-xs text-gray-500 mt-1">
                                {msg.parsed.start_time} - {msg.parsed.end_time}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    )) : (
                      <p className="text-center text-gray-500 py-8">Няма известия</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Settings Menu */}
        {menuOpen === 'settings' && (
          <div className="fixed inset-0 bg-black/50 z-50 animate-fade-in" onClick={() => setMenuOpen(null)}>
            <div className="absolute right-0 top-0 bottom-0 w-full max-w-sm bg-white shadow-2xl animate-slide-left" onClick={(e) => e.stopPropagation()}>
              <div className="h-full flex flex-col">
                {/* Header */}
                <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white px-6 py-4 flex items-center justify-between">
                  <h2 className="text-xl font-bold">Настройки</h2>
                  <button onClick={() => setMenuOpen(null)} className="p-2 hover:bg-white/20 rounded-lg">
                    <X className="w-6 h-6" />
                  </button>
                </div>

                {/* Menu Items */}
                <div className="flex-1 overflow-y-auto p-4 space-y-2">
                  <button
                    onClick={() => setMenuOpen('account')}
                    className="w-full flex items-center justify-between p-4 bg-gray-50 rounded-xl hover:bg-gray-100 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <Key className="w-5 h-5 text-blue-600" />
                      <span className="font-medium">Профил</span>
                    </div>
                    <ChevronRight className="w-5 h-5 text-gray-400" />
                  </button>

                  <button
                    onClick={() => setMenuOpen('personal')}
                    className="w-full flex items-center justify-between p-4 bg-gray-50 rounded-xl hover:bg-gray-100 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <User className="w-5 h-5 text-blue-600" />
                      <span className="font-medium">Лична информация</span>
                    </div>
                    <ChevronRight className="w-5 h-5 text-gray-400" />
                  </button>

                  <button
                    onClick={() => setMenuOpen('accessibility')}
                    className="w-full flex items-center justify-between p-4 bg-gray-50 rounded-xl hover:bg-gray-100 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <Accessibility className="w-5 h-5 text-blue-600" />
                      <span className="font-medium">Достъпност</span>
                    </div>
                    <ChevronRight className="w-5 h-5 text-gray-400" />
                  </button>

                  <button
                    onClick={() => setMenuOpen('notifications')}
                    className="w-full flex items-center justify-between p-4 bg-gray-50 rounded-xl hover:bg-gray-100 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <Bell className="w-5 h-5 text-blue-600" />
                      <span className="font-medium">Известия</span>
                    </div>
                    <ChevronRight className="w-5 h-5 text-gray-400" />
                  </button>

                  <button
                    onClick={() => setMenuOpen('chatbot')}
                    className="w-full flex items-center justify-between p-4 bg-gray-50 rounded-xl hover:bg-gray-100 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <Bot className="w-5 h-5 text-blue-600" />
                      <span className="font-medium">Чатбот</span>
                    </div>
                    <ChevronRight className="w-5 h-5 text-gray-400" />
                  </button>

                  <button
                    onClick={handleLogout}
                    className="w-full flex items-center gap-3 p-4 bg-red-50 rounded-xl hover:bg-red-100 transition-colors text-red-600 mt-4"
                  >
                    <LogIn className="w-5 h-5" />
                    <span className="font-medium">Изход</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Account Settings Submenu */}
        {menuOpen === 'account' && (
          <div className="fixed inset-0 bg-black/50 z-50 animate-fade-in" onClick={() => setMenuOpen('settings')}>
            <div className="absolute right-0 top-0 bottom-0 w-full max-w-sm bg-white shadow-2xl animate-slide-left" onClick={(e) => e.stopPropagation()}>
              <div className="h-full flex flex-col">
                <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white px-6 py-4 flex items-center gap-3">
                  <button onClick={() => setMenuOpen('settings')} className="p-2 hover:bg-white/20 rounded-lg">
                    <ChevronLeft className="w-6 h-6" />
                  </button>
                  <h2 className="text-xl font-bold">Акаунт</h2>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  <div className="bg-gray-50 rounded-xl p-4">
                    <label className="block text-sm font-medium text-gray-700 mb-2">Имейл</label>
                    <input type="email" value={userData.email} className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                  </div>
                  <button className="w-full p-4 bg-blue-50 text-blue-600 rounded-xl font-medium hover:bg-blue-100">
                    Смяна на парола
                  </button>
                  <button className="w-full p-4 bg-red-50 text-red-600 rounded-xl font-medium hover:bg-red-100">
                    <Trash2 className="w-5 h-5 inline mr-2" />
                    Изтриване на акаунт
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Personal Info Submenu */}
        {menuOpen === 'personal' && (
          <div className="fixed inset-0 bg-black/50 z-50" onClick={() => setMenuOpen('settings')}>
            <div className="absolute right-0 top-0 bottom-0 w-full max-w-sm bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="h-full flex flex-col">
                <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white px-6 py-4 flex items-center gap-3">
                  <button onClick={() => setMenuOpen('settings')} className="p-2 hover:bg-white/20 rounded-lg">
                    <ChevronLeft className="w-6 h-6" />
                  </button>
                  <h2 className="text-xl font-bold">Лична информация</h2>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  <div className="flex justify-center mb-4">
                    <div className="relative">
                      <div className="w-24 h-24 bg-blue-100 rounded-full flex items-center justify-center">
                        <User className="w-12 h-12 text-blue-600" />
                      </div>
                      <button className="absolute bottom-0 right-0 p-2 bg-blue-600 text-white rounded-full shadow-lg">
                        <Camera className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Име</label>
                      <input type="text" value={userData.name} onChange={(e) => setUserData({...userData, name: e.target.value})} className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Биография</label>
                      <textarea value={userData.bio} onChange={(e) => setUserData({...userData, bio: e.target.value})} rows="3" className="w-full px-4 py-2 border border-gray-300 rounded-lg"></textarea>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Телефон</label>
                      <input type="tel" value={userData.phone} onChange={(e) => setUserData({...userData, phone: e.target.value})} className="w-full px-4 py-2 border border-gray-300 rounded-lg" />
                    </div>
                  </div>
                  <button className="w-full p-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700">
                    Запази промените
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Accessibility Submenu */}
        {menuOpen === 'accessibility' && (
          <div className="fixed inset-0 bg-black/50 z-50" onClick={() => setMenuOpen('settings')}>
            <div className="absolute right-0 top-0 bottom-0 w-full max-w-sm bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="h-full flex flex-col">
                <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white px-6 py-4 flex items-center gap-3">
                  <button onClick={() => setMenuOpen('settings')} className="p-2 hover:bg-white/20 rounded-lg">
                    <ChevronLeft className="w-6 h-6" />
                  </button>
                  <h2 className="text-xl font-bold">Достъпност</h2>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
                    <div className="flex items-center gap-3">
                      <Palette className="w-5 h-5 text-blue-600" />
                      <span className="font-medium">Висок контраст</span>
                    </div>
                    <input type="checkbox" checked={settings.highContrast} onChange={(e) => setSettings({...settings, highContrast: e.target.checked})} className="w-5 h-5 text-blue-600 rounded" />
                  </div>
                  <div className="p-4 bg-gray-50 rounded-xl">
                    <div className="flex items-center gap-3 mb-3">
                      <span className="font-medium">Размер на текста</span>
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      {['small', 'medium', 'large', 'xlarge'].map((size) => (
                        <button key={size} onClick={() => setSettings({...settings, textSize: size})} className={`py-2 rounded-lg font-medium text-sm ${settings.textSize === size ? 'bg-blue-600 text-white' : 'bg-white text-gray-700'}`}>
                          {size === 'small' ? 'S' : size === 'medium' ? 'M' : size === 'large' ? 'L' : 'XL'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
                    <span className="font-medium">Намали анимациите</span>
                    <input type="checkbox" checked={settings.reduceMotion} onChange={(e) => setSettings({...settings, reduceMotion: e.target.checked})} className="w-5 h-5 text-blue-600 rounded" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Notifications Submenu */}
        {menuOpen === 'notifications' && (
          <div className="fixed inset-0 bg-black/50 z-50" onClick={() => setMenuOpen('settings')}>
            <div className="absolute right-0 top-0 bottom-0 w-full max-w-sm bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="h-full flex flex-col">
                <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white px-6 py-4 flex items-center gap-3">
                  <button onClick={() => setMenuOpen('settings')} className="p-2 hover:bg-white/20 rounded-lg">
                    <ChevronLeft className="w-6 h-6" />
                  </button>
                  <h2 className="text-xl font-bold">Известия</h2>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
                    <div className="flex items-center gap-3">
                      <Bell className="w-5 h-5 text-blue-600" />
                      <span className="font-medium">Push известия</span>
                    </div>
                    <input type="checkbox" checked={settings.notificationsEnabled} onChange={(e) => setSettings({...settings, notificationsEnabled: e.target.checked})} className="w-5 h-5 text-blue-600 rounded" />
                  </div>
                  <div className="p-4 bg-gray-50 rounded-xl">
                    <label className="block text-sm font-medium text-gray-700 mb-3">Честота</label>
                    <select value={settings.notificationFrequency} onChange={(e) => setSettings({...settings, notificationFrequency: e.target.value})} className="w-full px-4 py-2 border border-gray-300 rounded-lg">
                      <option value="realtime">Веднага</option>
                      <option value="daily">Дневен дайджест</option>
                      <option value="weekly">Седмичен дайджест</option>
                      <option value="off">Изключени</option>
                    </select>
                  </div>
                  <div className="p-4 bg-gray-50 rounded-xl">
                    <label className="block text-sm font-medium text-gray-700 mb-3">Тихи часове</label>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-gray-600">От</label>
                        <input type="time" value={settings.quietHoursStart} onChange={(e) => setSettings({...settings, quietHoursStart: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                      </div>
                      <div>
                        <label className="text-xs text-gray-600">До</label>
                        <input type="time" value={settings.quietHoursEnd} onChange={(e) => setSettings({...settings, quietHoursEnd: e.target.value})} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Chatbot Submenu */}
        {menuOpen === 'chatbot' && (
          <div className="fixed inset-0 bg-black/50 z-50" onClick={() => setMenuOpen('settings')}>
            <div className="absolute right-0 top-0 bottom-0 w-full max-w-sm bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="h-full flex flex-col">
                <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white px-6 py-4 flex items-center gap-3">
                  <button onClick={() => setMenuOpen('settings')} className="p-2 hover:bg-white/20 rounded-lg">
                    <ChevronLeft className="w-6 h-6" />
                  </button>
                  <h2 className="text-xl font-bold">Чатбот</h2>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  <div className="p-4 bg-gray-50 rounded-xl">
                    <label className="block text-sm font-medium text-gray-700 mb-3">Личност на бота</label>
                    <select className="w-full px-4 py-2 border border-gray-300 rounded-lg">
                      <option>Професионален</option>
                      <option>Приятелски</option>
                      <option>Официален</option>
                    </select>
                  </div>
                  <div className="p-4 bg-gray-50 rounded-xl">
                    <label className="block text-sm font-medium text-gray-700 mb-3">Скорост на отговор</label>
                    <select className="w-full px-4 py-2 border border-gray-300 rounded-lg">
                      <option>Бърза</option>
                      <option>Средна</option>
                      <option>Подробна</option>
                    </select>
                  </div>
                  <button className="w-full p-4 bg-red-50 text-red-600 rounded-xl font-medium hover:bg-red-100">
                    Изчисти историята
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Profile Menu */}
        {menuOpen === 'profile' && (
          <div className="fixed inset-0 bg-black/50 z-50" onClick={() => setMenuOpen(null)}>
            <div className="absolute right-0 top-0 bottom-0 w-full max-w-sm bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="h-full flex flex-col">
                <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white px-6 py-8">
                  <button onClick={() => setMenuOpen(null)} className="mb-4 p-2 hover:bg-white/20 rounded-lg inline-block">
                    <X className="w-6 h-6" />
                  </button>
                  <div className="flex items-center gap-4">
                    <div className="w-20 h-20 bg-white/30 rounded-full flex items-center justify-center">
                      <User className="w-10 h-10 text-white" />
                    </div>
                    <div>
                      <h2 className="text-2xl font-bold">{userData.name}</h2>
                      <p className="text-blue-100">{userData.email}</p>
                    </div>
                  </div>
                </div>
                <div className="flex-1 p-4 space-y-3">
                  <div className="bg-gray-50 rounded-xl p-4">
                    <p className="text-sm text-gray-600 mb-1">Биография</p>
                    <p className="font-medium">{userData.bio}</p>
                  </div>
                  <div className="bg-gray-50 rounded-xl p-4">
                    <p className="text-sm text-gray-600 mb-1">Телефон</p>
                    <p className="font-medium">{userData.phone}</p>
                  </div>
                  <button onClick={() => setMenuOpen('personal')} className="w-full p-3 bg-blue-600 text-white rounded-xl font-medium hover:bg-blue-700">
                    Редактирай профил
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Chat Interface */}
        {menuOpen === 'chat' && (
          <div className="fixed inset-0 bg-white z-50">
            <div className="h-full flex flex-col">
              <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white px-6 py-4 flex items-center gap-3">
                <button onClick={() => setMenuOpen(null)} className="p-2 hover:bg-white/20 rounded-lg">
                  <X className="w-6 h-6" />
                </button>
                <Bot className="w-6 h-6" />
                <h2 className="text-xl font-bold">CityShield Асистент</h2>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50">
                <div className="flex gap-3">
                  <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center flex-shrink-0">
                    <Bot className="w-5 h-5 text-white" />
                  </div>
                  <div className="bg-white rounded-2xl rounded-tl-none p-4 shadow-sm max-w-[80%]">
                    <p className="text-sm">Здравейте! Аз съм вашият CityShield асистент. Как мога да ви помогна днес?</p>
                  </div>
                </div>
                <div className="flex gap-3 justify-end">
                  <div className="bg-blue-600 text-white rounded-2xl rounded-tr-none p-4 shadow-sm max-w-[80%]">
                    <p className="text-sm">Кога ще възстановят водата в Аспарухово?</p>
                  </div>
                  <div className="w-8 h-8 bg-gray-300 rounded-full flex items-center justify-center flex-shrink-0">
                    <User className="w-5 h-5 text-gray-600" />
                  </div>
                </div>
                <div className="flex gap-3">
                  <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center flex-shrink-0">
                    <Bot className="w-5 h-5 text-white" />
                  </div>
                  <div className="bg-white rounded-2xl rounded-tl-none p-4 shadow-sm max-w-[80%]">
                    <p className="text-sm">Според последната информация, водоснабдяването в кв. Аспарухово ще бъде възстановено до 18:30 ч. днес. Прекъсването е заради авария на бул. "Владислав Варненчик".</p>
                  </div>
                </div>
              </div>
              <div className="p-4 bg-white border-t">
                <div className="flex gap-2">
                  <input type="text" placeholder="Напишете съобщение..." className="flex-1 px-4 py-3 border border-gray-300 rounded-full focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
                  <button className="p-3 bg-blue-600 text-white rounded-full hover:bg-blue-700 transition-colors">
                    <MessageCircle className="w-6 h-6" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return null;
}
                  