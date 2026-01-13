import React, { useState } from 'react';
import { MapPin } from 'lucide-react';

const LoginPage = ({ onLoginSuccess, mockUsers, setMockUsers }) => {
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

  const handleLogin = (e) => {
    e.preventDefault();
    setLoginError('');

    console.log('Login attempt:', loginForm.email);
    console.log('Available users:', mockUsers);

    const user = mockUsers.find(u => u.email.trim().toLowerCase() === loginForm.email.trim().toLowerCase());

    if (!user) {
      setLoginError('Потребителят не е регистриран');
      console.log('User not found');
      return;
    }

    console.log('User found:', user);
    console.log('Password check:', user.password, '===', loginForm.password);

    if (user.password !== loginForm.password) {
      setLoginError('Грешна парола');
      console.log('Wrong password');
      return;
    }

    console.log('Login successful!');

    // Successful login - pass user data to parent
    onLoginSuccess({
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      addresses: user.addresses || []
    });
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
    
    // Successful registration - pass user data to parent
    onLoginSuccess({
      firstName: newUser.firstName,
      lastName: newUser.lastName,
      email: newUser.email,
      addresses: []
    });
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ backgroundColor: '#f0f9ff' }}>
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-block mb-4">
            <img 
              src="https://i.imgur.com/9LHZk9j.png" 
              alt="CityShield Logo" 
              className="w-48 h-auto mx-auto"
            />
          </div>
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
};

export default LoginPage;