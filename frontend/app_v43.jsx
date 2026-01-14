import React, { useState, useEffect } from 'react';
import { MapPin, Menu, X, Settings, Clock, Map, Info, User, Mail, Home, LogOut, Trash2, Plus, AlertCircle } from 'lucide-react';

const UtilityOutageApp = () => {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [showLogin, setShowLogin] = useState(true);
  const [showRegister, setShowRegister] = useState(false);
  const [loginError, setLoginError] = useState('');
  
  const [loginForm, setLoginForm] = useState({
    email: '',
    password: ''
  });

  const [registerForm, setRegisterForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    confirmPassword: ''
  });

  // Mock user database - in real app, this would be a backend API
  const [mockUsers, setMockUsers] = useState([
    {
      firstName: 'Иван',
      lastName: 'Петров',
      email: 'ivan.petrov@example.com',
      password: 'password123',
      addresses: [
        { 
          street: 'бул. Владислав Варненчик 25, Варна',
          neighborhood: 'Левски'
        },
        { 
          street: 'ул. Царевец 10, Варна',
          neighborhood: 'Възраждане'
        }
      ]
    }
  ]);

  const [outages, setOutages] = useState([]);
  const [selectedOutage, setSelectedOutage] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [bottomSheetOpen, setBottomSheetOpen] = useState(false);
  const [mapCenter, setMapCenter] = useState({ lat: 43.2141, lng: 27.9147 }); // Varna coordinates
  const [settings, setSettings] = useState({
    notifications: true,
    autoRefresh: true,
    refreshInterval: 30
  });

  const [userProfile, setUserProfile] = useState({
    firstName: '',
    lastName: '',
    email: '',
    addresses: []
  });

  const [showAddAddress, setShowAddAddress] = useState(false);
  const [newAddress, setNewAddress] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [swipeMenuOpen, setSwipeMenuOpen] = useState(false);
  const [touchStart, setTouchStart] = useState(0);
  const [touchEnd, setTouchEnd] = useState(0);
  const [wheelDelta, setWheelDelta] = useState(0);

  // Mock data - replace with actual API call to your backend
  useEffect(() => {
    const mockOutages = [
      {
        id: 16186,
        date: "13.01.2026",
        message: "Поради предизвикана авария от частна фирма на ул. '13-та', без вода ще бъдат абонатите от висока зона на м-т 'Евксиноград' и м-т 'Малко Ю' от 10:30 до 17:00 ч.",
        locations: ["м-т Евксиноград", "м-т Малко Ю"],
        start_time: "10:30",
        end_time: "17:00",
        lat: 43.2350,
        lng: 27.9450
      },
      {
        id: 16185,
        date: "12.01.2026",
        message: "Планирана профилактика в район 'Левски' от 09:00 до 15:00 ч.",
        locations: ["район Левски"],
        start_time: "09:00",
        end_time: "15:00",
        lat: 43.2070,
        lng: 27.9100
      },
      {
        id: 16184,
        date: "12.01.2026",
        message: "Авария на водопровод в кв. 'Възраждане' от 14:00 до 18:30 ч.",
        locations: ["кв. Възраждане"],
        start_time: "14:00",
        end_time: "18:30",
        lat: 43.2180,
        lng: 27.8950
      }
    ];
    setOutages(mockOutages);
  }, []);

  const handleMarkerClick = (outage) => {
    setSelectedOutage(outage);
    setBottomSheetOpen(true);
  };

  const toggleSidebar = () => {
    setSidebarOpen(!sidebarOpen);
  };

  const handleSettingChange = (key, value) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const handleAddAddress = () => {
    if (newAddress.trim()) {
      const neighborhood = detectNeighborhood(newAddress);
      setUserProfile(prev => ({
        ...prev,
        addresses: [...prev.addresses, { street: newAddress.trim(), neighborhood }]
      }));
      setNewAddress('');
      setShowAddAddress(false);
    }
  };

  const handleRemoveAddress = (index) => {
    setUserProfile(prev => ({
      ...prev,
      addresses: prev.addresses.filter((_, i) => i !== index)
    }));
  };

  // Function to detect neighborhood based on street address
  const detectNeighborhood = (address) => {
    const addressLower = address.toLowerCase();
    
    // Varna neighborhood mapping
    const neighborhoods = {
      'левски': ['владислав варненчик', 'цар симеон', 'искър'],
      'възраждане': ['царевец', 'стефан караджа', 'роза'],
      'аспарухово': ['аспарухово', 'девня'],
      'младост': ['младост', 'христо ботев'],
      'трошево': ['трошево', 'бенковски'],
      'вл. варненчик': ['вл. варненчик'],
      'център': ['преслав', 'шипка', 'цар калоян', 'драгоман', 'опълченска'],
      'чайка': ['чайка', 'златни пясъци'],
      'бриз': ['бриз', 'св. св. константин и елена'],
      'евксиноград': ['евксиноград'],
      'galata': ['галата'],
      'прибой': ['прибой']
    };

    for (const [neighborhood, keywords] of Object.entries(neighborhoods)) {
      if (keywords.some(keyword => addressLower.includes(keyword))) {
        return neighborhood.charAt(0).toUpperCase() + neighborhood.slice(1);
      }
    }

    return 'Неизвестен район';
  };

  const handleLogout = () => {
    setIsLoggedIn(false);
    setShowLogin(true);
    setUserProfile({
      firstName: '',
      lastName: '',
      email: '',
      addresses: []
    });
    setLoginForm({ email: '', password: '' });
    setLoginError('');
  };

  const handleLogin = (e) => {
    e.preventDefault();
    setLoginError('');

    const user = mockUsers.find(u => u.email === loginForm.email);

    if (!user) {
      setLoginError('Потребителят не е регистриран');
      return;
    }

    if (user.password !== loginForm.password) {
      setLoginError('Грешна парола');
      return;
    }

    // Successful login
    setUserProfile({
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      addresses: user.addresses
    });
    setIsLoggedIn(true);
    setLoginError('');
  };

  const handleRegister = (e) => {
    e.preventDefault();
    setLoginError('');

    // Validation
    if (!registerForm.firstName || !registerForm.lastName || !registerForm.email || !registerForm.password) {
      setLoginError('Моля, попълнете всички полета');
      return;
    }

    if (registerForm.password !== registerForm.confirmPassword) {
      setLoginError('Паролите не съвпадат');
      return;
    }

    // Check if user already exists
    if (mockUsers.find(u => u.email === registerForm.email)) {
      setLoginError('Потребител с този имейл вече съществува');
      return;
    }

    // Create new user
    const newUser = {
      firstName: registerForm.firstName,
      lastName: registerForm.lastName,
      email: registerForm.email,
      password: registerForm.password,
      addresses: []
    };

    setMockUsers([...mockUsers, newUser]);
    setUserProfile({
      firstName: newUser.firstName,
      lastName: newUser.lastName,
      email: newUser.email,
      addresses: []
    });
    setIsLoggedIn(true);
    setShowRegister(false);
    setRegisterForm({
      firstName: '',
      lastName: '',
      email: '',
      password: '',
      confirmPassword: ''
    });
  };

  const handleDeleteProfile = () => {
    if (showDeleteConfirm) {
      alert('Профилът е изтрит');
      // Add delete profile logic here
      setShowDeleteConfirm(false);
    } else {
      setShowDeleteConfirm(true);
    }
  };

  // Gesture handlers for swipe up
  const handleTouchStart = (e) => {
    setTouchStart(e.touches[0].clientY);
  };

  const handleTouchMove = (e) => {
    setTouchEnd(e.touches[0].clientY);
  };

  const handleTouchEnd = () => {
    if (touchStart - touchEnd > 50) {
      // Swiped up
      setSwipeMenuOpen(true);
    }
    if (touchEnd - touchStart > 50 && swipeMenuOpen) {
      // Swiped down
      setSwipeMenuOpen(false);
    }
    setTouchStart(0);
    setTouchEnd(0);
  };

  // Trackpad/wheel handler for swipe up gesture
  const handleWheel = (e) => {
    // Detect upward scroll (negative deltaY means scrolling up)
    if (e.deltaY < -50 && !swipeMenuOpen && !sidebarOpen && !bottomSheetOpen) {
      // Accumulate wheel delta to prevent accidental triggers
      setWheelDelta(prev => {
        const newDelta = prev + e.deltaY;
        if (newDelta < -100) {
          setSwipeMenuOpen(true);
          return 0;
        }
        return newDelta;
      });
    } else if (e.deltaY > 50 && swipeMenuOpen) {
      // Scroll down to close
      setWheelDelta(prev => {
        const newDelta = prev + e.deltaY;
        if (newDelta > 100) {
          setSwipeMenuOpen(false);
          return 0;
        }
        return newDelta;
      });
    } else {
      // Reset if direction changes
      setTimeout(() => setWheelDelta(0), 200);
    }
  };

  // Filter outages near user addresses
  const getNearbyOutages = () => {
    const userNeighborhoods = userProfile.addresses.map(addr => addr.neighborhood.toLowerCase());
    
    return outages.filter(outage => {
      return outage.locations.some(location => {
        const locationLower = location.toLowerCase();
        
        // Check if any user neighborhood matches the outage location
        return userNeighborhoods.some(neighborhood => {
          // Direct match
          if (locationLower.includes(neighborhood) || neighborhood.includes(locationLower)) {
            return true;
          }
          
          // Check for partial matches with common location patterns
          const neighborhoodWords = neighborhood.split(' ');
          return neighborhoodWords.some(word => {
            if (word.length > 3) { // Only match meaningful words
              return locationLower.includes(word);
            }
            return false;
          });
        });
      });
    });
  };

  const nearbyOutages = getNearbyOutages();

  // Login/Register Page
  if (!isLoggedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4" style={{ backgroundColor: '#f0f9ff' }}>
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="inline-block p-4 rounded-full mb-4" style={{ backgroundColor: '#289DD2' }}>
              <MapPin className="w-12 h-12 text-white" />
            </div>
            <h1 className="text-3xl font-bold mb-2" style={{ color: '#1A61CC' }}>
              ВиК Варна
            </h1>
            <p className="text-gray-600">Проследяване на аварии</p>
          </div>

          {showLogin && !showRegister ? (
            <div className="bg-white rounded-2xl shadow-xl p-8">
              <h2 className="text-2xl font-bold mb-6 text-center" style={{ color: '#1A61CC' }}>
                Вход
              </h2>

              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Имейл адрес
                  </label>
                  <input
                    type="email"
                    value={loginForm.email}
                    onChange={(e) => setLoginForm({ ...loginForm, email: e.target.value })}
                    className="w-full px-4 py-3 border-2 rounded-lg focus:outline-none"
                    style={{ borderColor: '#289DD2' }}
                    placeholder="example@email.com"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Парола
                  </label>
                  <input
                    type="password"
                    value={loginForm.password}
                    onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
                    className="w-full px-4 py-3 border-2 rounded-lg focus:outline-none"
                    style={{ borderColor: '#289DD2' }}
                    placeholder="••••••••"
                    required
                  />
                </div>

                {loginError && (
                  <div className="p-3 rounded-lg bg-red-50 border border-red-200">
                    <p className="text-sm text-red-600 font-medium">{loginError}</p>
                    {loginError === 'Потребителят не е регистриран' && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowRegister(true);
                          setShowLogin(false);
                          setLoginError('');
                        }}
                        className="mt-2 text-sm font-medium underline"
                        style={{ color: '#1A61CC' }}
                      >
                        Създайте акаунт
                      </button>
                    )}
                  </div>
                )}

                <button
                  type="submit"
                  className="w-full py-3 rounded-lg text-white font-bold text-lg transition-all hover:opacity-90"
                  style={{ backgroundColor: '#289DD2' }}
                >
                  Вход
                </button>
              </form>

              <div className="mt-6 text-center">
                <p className="text-sm text-gray-600">
                  Нямате акаунт?{' '}
                  <button
                    onClick={() => {
                      setShowRegister(true);
                      setShowLogin(false);
                      setLoginError('');
                    }}
                    className="font-medium underline"
                    style={{ color: '#1A61CC' }}
                  >
                    Регистрирайте се
                  </button>
                </p>
              </div>

              <div className="mt-6 p-4 rounded-lg" style={{ backgroundColor: '#e3f2fd' }}>
                <p className="text-xs text-gray-600 mb-2">
                  <strong>Тестов акаунт:</strong>
                </p>
                <p className="text-xs text-gray-600">Email: ivan.petrov@example.com</p>
                <p className="text-xs text-gray-600">Парола: password123</p>
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-2xl shadow-xl p-8">
              <h2 className="text-2xl font-bold mb-6 text-center" style={{ color: '#1A61CC' }}>
                Регистрация
              </h2>

              <form onSubmit={handleRegister} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Име
                    </label>
                    <input
                      type="text"
                      value={registerForm.firstName}
                      onChange={(e) => setRegisterForm({ ...registerForm, firstName: e.target.value })}
                      className="w-full px-4 py-3 border-2 rounded-lg focus:outline-none"
                      style={{ borderColor: '#289DD2' }}
                      placeholder="Иван"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Фамилия
                    </label>
                    <input
                      type="text"
                      value={registerForm.lastName}
                      onChange={(e) => setRegisterForm({ ...registerForm, lastName: e.target.value })}
                      className="w-full px-4 py-3 border-2 rounded-lg focus:outline-none"
                      style={{ borderColor: '#289DD2' }}
                      placeholder="Петров"
                      required
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Имейл адрес
                  </label>
                  <input
                    type="email"
                    value={registerForm.email}
                    onChange={(e) => setRegisterForm({ ...registerForm, email: e.target.value })}
                    className="w-full px-4 py-3 border-2 rounded-lg focus:outline-none"
                    style={{ borderColor: '#289DD2' }}
                    placeholder="example@email.com"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Парола
                  </label>
                  <input
                    type="password"
                    value={registerForm.password}
                    onChange={(e) => setRegisterForm({ ...registerForm, password: e.target.value })}
                    className="w-full px-4 py-3 border-2 rounded-lg focus:outline-none"
                    style={{ borderColor: '#289DD2' }}
                    placeholder="••••••••"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Потвърди парола
                  </label>
                  <input
                    type="password"
                    value={registerForm.confirmPassword}
                    onChange={(e) => setRegisterForm({ ...registerForm, confirmPassword: e.target.value })}
                    className="w-full px-4 py-3 border-2 rounded-lg focus:outline-none"
                    style={{ borderColor: '#289DD2' }}
                    placeholder="••••••••"
                    required
                  />
                </div>

                {loginError && (
                  <div className="p-3 rounded-lg bg-red-50 border border-red-200">
                    <p className="text-sm text-red-600 font-medium">{loginError}</p>
                  </div>
                )}

                <button
                  type="submit"
                  className="w-full py-3 rounded-lg text-white font-bold text-lg transition-all hover:opacity-90"
                  style={{ backgroundColor: '#289DD2' }}
                >
                  Регистрация
                </button>
              </form>

              <div className="mt-6 text-center">
                <p className="text-sm text-gray-600">
                  Вече имате акаунт?{' '}
                  <button
                    onClick={() => {
                      setShowRegister(false);
                      setShowLogin(true);
                      setLoginError('');
                    }}
                    className="font-medium underline"
                    style={{ color: '#1A61CC' }}
                  >
                    Влезте
                  </button>
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Main App (shown after successful login)

  return (
    <div 
      className="relative h-screen w-full overflow-hidden bg-white font-sans"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onWheel={handleWheel}
    >
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 z-30 bg-white shadow-md">
        <div className="flex items-center justify-between p-4">
          <button
            onClick={toggleSidebar}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <Menu className="w-6 h-6" style={{ color: '#1A61CC' }} />
          </button>
          <h1 className="text-xl font-bold" style={{ color: '#1A61CC' }}>
            ВиК Варна Аварии
          </h1>
          <div className="w-10" />
        </div>
      </div>

      {/* Sidebar */}
      <div
        className={`absolute top-0 left-0 h-full w-80 bg-white shadow-2xl z-40 transform transition-transform duration-300 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex flex-col h-full">
          <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: '#289DD2' }}>
            <div className="flex items-center gap-2">
              <Settings className="w-6 h-6" style={{ color: '#1A61CC' }} />
              <h2 className="text-xl font-bold" style={{ color: '#1A61CC' }}>Настройки</h2>
            </div>
            <button
              onClick={toggleSidebar}
              className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
            >
              <X className="w-6 h-6" style={{ color: '#1A61CC' }} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            <div className="space-y-6">
              {/* Account Section */}
              <div className="pb-4 border-b border-gray-200">
                <h3 className="font-bold mb-4" style={{ color: '#1A61CC' }}>Профил</h3>
                
                <div className="space-y-3 mb-4">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg" style={{ backgroundColor: '#e3f2fd' }}>
                      <User className="w-5 h-5" style={{ color: '#1A61CC' }} />
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Име</p>
                      <p className="font-medium text-gray-800">{userProfile.firstName} {userProfile.lastName}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg" style={{ backgroundColor: '#e3f2fd' }}>
                      <Mail className="w-5 h-5" style={{ color: '#1A61CC' }} />
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Имейл</p>
                      <p className="font-medium text-gray-800">{userProfile.email}</p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <div className="p-2 rounded-lg" style={{ backgroundColor: '#e3f2fd' }}>
                      <Home className="w-5 h-5" style={{ color: '#1A61CC' }} />
                    </div>
                    <div className="flex-1">
                      <p className="text-xs text-gray-500 mb-2">Адреси</p>
                      <div className="space-y-2">
                        {userProfile.addresses.map((address, index) => (
                          <div key={index} className="flex items-start justify-between gap-2 p-3 bg-gray-50 rounded-lg">
                            <div className="flex-1">
                              <p className="text-sm font-medium text-gray-800">{address.street}</p>
                              <p className="text-xs text-gray-500 mt-1">
                                <span className="px-2 py-0.5 rounded" style={{ backgroundColor: '#e3f2fd', color: '#1A61CC' }}>
                                  {address.neighborhood}
                                </span>
                              </p>
                            </div>
                            <button
                              onClick={() => handleRemoveAddress(index)}
                              className="p-1 hover:bg-gray-200 rounded transition-colors flex-shrink-0"
                            >
                              <X className="w-4 h-4 text-gray-500" />
                            </button>
                          </div>
                        ))}
                      </div>
                      
                      {showAddAddress ? (
                        <div className="mt-2 space-y-2">
                          <input
                            type="text"
                            value={newAddress}
                            onChange={(e) => setNewAddress(e.target.value)}
                            placeholder="Въведете нов адрес..."
                            className="w-full p-2 border-2 rounded-lg focus:outline-none text-sm"
                            style={{ borderColor: '#289DD2' }}
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={handleAddAddress}
                              className="flex-1 py-2 px-3 rounded-lg text-white font-medium text-sm transition-colors"
                              style={{ backgroundColor: '#289DD2' }}
                            >
                              Добави
                            </button>
                            <button
                              onClick={() => {
                                setShowAddAddress(false);
                                setNewAddress('');
                              }}
                              className="flex-1 py-2 px-3 bg-gray-200 rounded-lg font-medium text-sm transition-colors hover:bg-gray-300"
                            >
                              Отказ
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => setShowAddAddress(true)}
                          className="mt-2 flex items-center gap-2 py-2 px-3 rounded-lg font-medium text-sm transition-colors w-full justify-center"
                          style={{ backgroundColor: '#e3f2fd', color: '#1A61CC' }}
                        >
                          <Plus className="w-4 h-4" />
                          Добави нов адрес
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                <div className="space-y-2 mt-4">
                  <button
                    onClick={handleLogout}
                    className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-lg font-medium transition-colors"
                    style={{ backgroundColor: '#289DD2', color: 'white' }}
                  >
                    <LogOut className="w-5 h-5" />
                    Изход
                  </button>

                  <button
                    onClick={handleDeleteProfile}
                    className={`w-full flex items-center justify-center gap-2 py-2 px-4 rounded-lg font-medium transition-colors ${
                      showDeleteConfirm ? 'bg-red-600 text-white' : 'bg-red-50 text-red-600'
                    }`}
                  >
                    <Trash2 className="w-5 h-5" />
                    {showDeleteConfirm ? 'Потвърди изтриване' : 'Изтрий профил'}
                  </button>
                  
                  {showDeleteConfirm && (
                    <button
                      onClick={() => setShowDeleteConfirm(false)}
                      className="w-full py-2 px-4 bg-gray-200 rounded-lg font-medium text-sm transition-colors hover:bg-gray-300"
                    >
                      Отказ
                    </button>
                  )}
                </div>
              </div>

              {/* Settings Section */}
              <div className="pb-4 border-b border-gray-200">
                <h3 className="font-bold mb-4" style={{ color: '#1A61CC' }}>Настройки</h3>
              <div className="flex items-center justify-between">
                <label className="text-gray-700 font-medium">Известия</label>
                <button
                  onClick={() => handleSettingChange('notifications', !settings.notifications)}
                  className={`w-12 h-6 rounded-full transition-colors ${
                    settings.notifications ? 'bg-blue-500' : 'bg-gray-300'
                  }`}
                  style={settings.notifications ? { backgroundColor: '#289DD2' } : {}}
                >
                  <div
                    className={`w-5 h-5 bg-white rounded-full shadow-md transform transition-transform ${
                      settings.notifications ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between">
                <label className="text-gray-700 font-medium">Автоматично обновяване</label>
                <button
                  onClick={() => handleSettingChange('autoRefresh', !settings.autoRefresh)}
                  className={`w-12 h-6 rounded-full transition-colors ${
                    settings.autoRefresh ? 'bg-blue-500' : 'bg-gray-300'
                  }`}
                  style={settings.autoRefresh ? { backgroundColor: '#289DD2' } : {}}
                >
                  <div
                    className={`w-5 h-5 bg-white rounded-full shadow-md transform transition-transform ${
                      settings.autoRefresh ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              <div>
                <label className="text-gray-700 font-medium block mb-2">
                  Интервал на обновяване (минути)
                </label>
                <input
                  type="number"
                  value={settings.refreshInterval}
                  onChange={(e) => handleSettingChange('refreshInterval', parseInt(e.target.value))}
                  className="w-full p-2 border-2 rounded-lg focus:outline-none focus:border-blue-500"
                  style={{ borderColor: '#289DD2' }}
                  min="5"
                  max="120"
                />
              </div>
            </div>

              {/* About Section */}
              <div className="pt-4 border-t border-gray-200">
                <h3 className="font-bold mb-2" style={{ color: '#1A61CC' }}>За приложението</h3>
                <p className="text-sm text-gray-600">
                  ВиК Варна проследяване на аварии ви помага да бъдете информирани за прекъсванията на водоснабдяването във Варна, България.
                </p>
                <p className="text-sm text-gray-500 mt-2">Версия 1.0.0</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Map Container */}
      <div className="absolute inset-0 pt-16" style={{ backgroundColor: '#f0f9ff' }}>
        <div className="relative w-full h-full">
          {/* Simple map representation */}
          <div className="w-full h-full relative">
            <div className="absolute inset-0 flex items-center justify-center">
              <Map className="w-16 h-16 text-gray-300" />
              <p className="absolute bottom-1/3 text-gray-400 text-sm">Карта - Варна</p>
            </div>

            {/* Outage Markers */}
            {outages.map((outage, index) => (
              <button
                key={outage.id}
                onClick={() => handleMarkerClick(outage)}
                className={`absolute transform -translate-x-1/2 -translate-y-full hover:scale-110 transition-all ${
                  bottomSheetOpen && selectedOutage?.id === outage.id ? 'opacity-0 pointer-events-none' : 'opacity-100'
                }`}
                style={{
                  left: `${30 + index * 20}%`,
                  top: `${40 + index * 15}%`
                }}
              >
                <MapPin
                  className="w-10 h-10 drop-shadow-lg"
                  style={{ color: '#289DD2', fill: '#289DD2', stroke: '#1A61CC', strokeWidth: 1 }}
                />
              </button>
            ))}
          </div>

          {/* Outage Count Badge */}
          <div
            className="absolute top-4 right-4 px-4 py-2 rounded-full shadow-lg text-white font-bold"
            style={{ backgroundColor: '#1A61CC' }}
          >
            {outages.length} Активни аварии
          </div>
        </div>
      </div>

      {/* Bottom Sheet */}
      {bottomSheetOpen && selectedOutage && (
        <>
          <div
            className="fixed inset-0 bg-black bg-opacity-50 z-40"
            onClick={() => setBottomSheetOpen(false)}
          />
          <div className="fixed bottom-0 left-0 right-0 bg-white rounded-t-3xl shadow-2xl z-50 animate-slide-up">
            <div className="p-6">
              <div className="w-12 h-1 bg-gray-300 rounded-full mx-auto mb-4" />
              
              <div className="flex items-start justify-between mb-4">
                <h3 className="text-xl font-bold" style={{ color: '#1A61CC' }}>
                  Детайли за аварията
                </h3>
                <button
                  onClick={() => setBottomSheetOpen(false)}
                  className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5 text-gray-600" />
                </button>
              </div>

              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg" style={{ backgroundColor: '#e3f2fd' }}>
                    <Info className="w-5 h-5" style={{ color: '#1A61CC' }} />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-gray-500">ID</p>
                    <p className="font-semibold text-gray-800">{selectedOutage.id}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg" style={{ backgroundColor: '#e3f2fd' }}>
                    <Clock className="w-5 h-5" style={{ color: '#1A61CC' }} />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-gray-500">Дата</p>
                    <p className="font-semibold text-gray-800">{selectedOutage.date}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg" style={{ backgroundColor: '#e3f2fd' }}>
                    <Clock className="w-5 h-5" style={{ color: '#1A61CC' }} />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-gray-500">Време</p>
                    <p className="font-semibold text-gray-800">
                      {selectedOutage.start_time} - {selectedOutage.end_time}
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg" style={{ backgroundColor: '#e3f2fd' }}>
                    <MapPin className="w-5 h-5" style={{ color: '#1A61CC' }} />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-gray-500 mb-1">Засегнати локации</p>
                    <div className="flex flex-wrap gap-2">
                      {selectedOutage.locations.map((loc, idx) => (
                        <span
                          key={idx}
                          className="px-3 py-1 rounded-full text-sm font-medium text-white"
                          style={{ backgroundColor: '#289DD2' }}
                        >
                          {loc}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="pt-4 border-t border-gray-200">
                  <p className="text-sm text-gray-500 mb-2">Съобщение</p>
                  <p className="text-gray-700 leading-relaxed">{selectedOutage.message}</p>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Overlay for sidebar */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-30"
          onClick={toggleSidebar}
        />
      )}

      {/* Swipe Up Menu - Nearby Outages */}
      {swipeMenuOpen && (
        <>
          <div
            className="fixed inset-0 bg-black bg-opacity-50 z-40"
            onClick={() => setSwipeMenuOpen(false)}
          />
          <div className="fixed bottom-0 left-0 right-0 bg-white rounded-t-3xl shadow-2xl z-50 max-h-[80vh] overflow-y-auto">
            <div className="p-6">
              <div className="w-12 h-1 bg-gray-300 rounded-full mx-auto mb-4" />
              
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-6 h-6" style={{ color: '#1A61CC' }} />
                  <h3 className="text-xl font-bold" style={{ color: '#1A61CC' }}>
                    Аварии за Вас
                  </h3>
                </div>
                <button
                  onClick={() => setSwipeMenuOpen(false)}
                  className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5 text-gray-600" />
                </button>
              </div>

              {nearbyOutages.length > 0 ? (
                <div className="space-y-4">
                  <div className="mb-4 p-3 rounded-lg" style={{ backgroundColor: '#e3f2fd' }}>
                    <p className="text-xs font-medium" style={{ color: '#1A61CC' }}>
                      Показват се аварии за следните райони:
                    </p>
                    <div className="flex flex-wrap gap-2 mt-2">
                      {userProfile.addresses.map((addr, idx) => (
                        <span
                          key={idx}
                          className="px-2 py-1 rounded text-xs font-medium text-white"
                          style={{ backgroundColor: '#289DD2' }}
                        >
                          {addr.neighborhood}
                        </span>
                      ))}
                    </div>
                  </div>
                  
                  {nearbyOutages.map((outage) => (
                    <div
                      key={outage.id}
                      className="border-2 rounded-xl p-4 transition-all hover:shadow-md"
                      style={{ borderColor: '#289DD2' }}
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <div className="p-2 rounded-lg" style={{ backgroundColor: '#e3f2fd' }}>
                            <MapPin className="w-5 h-5" style={{ color: '#1A61CC' }} />
                          </div>
                          <div>
                            <p className="text-xs text-gray-500">ID: {outage.id}</p>
                            <p className="font-semibold text-gray-800">{outage.date}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium text-white" style={{ backgroundColor: '#289DD2' }}>
                          <Clock className="w-3 h-3" />
                          {outage.start_time} - {outage.end_time}
                        </div>
                      </div>

                      <div className="mb-3">
                        <p className="text-xs text-gray-500 mb-1">Засегнати локации:</p>
                        <div className="flex flex-wrap gap-2">
                          {outage.locations.map((loc, idx) => (
                            <span
                              key={idx}
                              className="px-2 py-1 rounded-lg text-xs font-medium"
                              style={{ backgroundColor: '#e3f2fd', color: '#1A61CC' }}
                            >
                              {loc}
                            </span>
                          ))}
                        </div>
                      </div>

                      <div className="p-3 bg-gray-50 rounded-lg">
                        <p className="text-xs text-gray-500 mb-1">Съобщение:</p>
                        <p className="text-sm text-gray-700 leading-relaxed">{outage.message}</p>
                      </div>

                      <button
                        onClick={() => {
                          setSwipeMenuOpen(false);
                          handleMarkerClick(outage);
                        }}
                        className="w-full mt-3 py-2 rounded-lg font-medium text-sm transition-colors"
                        style={{ backgroundColor: '#289DD2', color: 'white' }}
                      >
                        Покажи на картата
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8">
                  <div className="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center" style={{ backgroundColor: '#e3f2fd' }}>
                    <MapPin className="w-8 h-8" style={{ color: '#289DD2' }} />
                  </div>
                  <p className="text-gray-600 font-medium mb-2">Няма аварии в районите</p>
                  <div className="flex flex-wrap gap-2 justify-center mb-3">
                    {userProfile.addresses.map((addr, idx) => (
                      <span
                        key={idx}
                        className="px-2 py-1 rounded text-xs font-medium"
                        style={{ backgroundColor: '#e3f2fd', color: '#1A61CC' }}
                      >
                        {addr.neighborhood}
                      </span>
                    ))}
                  </div>
                  <p className="text-sm text-gray-500">В момента няма съобщени аварии в тези райони</p>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Swipe Up Indicator */}
      {!swipeMenuOpen && !bottomSheetOpen && !sidebarOpen && (
        <div className="fixed bottom-4 left-1/2 transform -translate-x-1/2 z-20 flex flex-col items-center animate-bounce">
          <div className="w-1 h-8 bg-gray-400 rounded-full mb-1" style={{ backgroundColor: '#289DD2' }}></div>
          <p className="text-xs font-medium" style={{ color: '#1A61CC' }}>Плъзнете нагоре / Скролирайте нагоре</p>
        </div>
      )}
    </div>
  );
};

export default UtilityOutageApp;