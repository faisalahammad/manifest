import type { ParentComponent } from 'solid-js';

const AuthLayout: ParentComponent = (props) => {
  return (
    <div class="auth-layout">
      <div class="auth-card">
        <div class="auth-logo">
          <a href="https://github.com/faisalahammad/tiergate" class="auth-logo__link">
            <img
              src="/logotype-white.svg"
              alt="TierGate"
              class="auth-logo__img auth-logo__img--light"
            />
            <img src="/logotype-dark.svg" alt="" class="auth-logo__img auth-logo__img--dark" />
          </a>
        </div>
        {props.children}
      </div>
    </div>
  );
};

export default AuthLayout;
