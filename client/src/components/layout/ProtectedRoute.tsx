import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../store/authStore';

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, requiresEnrollment, requires2faSetup, checkSession } = useAuthStore();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!user && !checked) {
      checkSession().then(ok => {
        setChecked(true);
        if (!ok) navigate('/login');
      });
    }
  }, [user, checked, checkSession, navigate]);

  // Redirect to enrollment if needed (must be in useEffect, not during render)
  useEffect(() => {
    if (!user) return;
    if (requiresEnrollment && location.pathname !== '/enroll') {
      navigate('/enroll', { replace: true });
    } else if (requires2faSetup && location.pathname !== '/setup-2fa' && location.pathname !== '/enroll') {
      navigate('/setup-2fa', { replace: true });
    }
  }, [user, requiresEnrollment, requires2faSetup, location.pathname, navigate]);

  if (!user && !checked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg-primary">
        <div className="text-text-secondary text-sm">Loading...</div>
      </div>
    );
  }

  if (!user) return null;

  // While redirect is pending, show loading to avoid flash
  if (requiresEnrollment && location.pathname !== '/enroll') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg-primary">
        <div className="text-text-secondary text-sm">Loading...</div>
      </div>
    );
  }
  if (requires2faSetup && location.pathname !== '/setup-2fa' && location.pathname !== '/enroll') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg-primary">
        <div className="text-text-secondary text-sm">Loading...</div>
      </div>
    );
  }

  return <>{children}</>;
}
