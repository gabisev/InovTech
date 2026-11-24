const menuToggle = document.querySelector(".menu-toggle");
const navLinks = document.querySelector(".nav-links");

if (menuToggle && navLinks) {
  menuToggle.addEventListener("click", () => {
    const isOpen = menuToggle.getAttribute("aria-expanded") === "true";
    menuToggle.setAttribute("aria-expanded", String(!isOpen));
    menuToggle.setAttribute("aria-label", isOpen ? "Ouvrir le menu" : "Fermer le menu");
    navLinks.classList.toggle("is-open", !isOpen);
  });

  navLinks.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      menuToggle.setAttribute("aria-expanded", "false");
      menuToggle.setAttribute("aria-label", "Ouvrir le menu");
      navLinks.classList.remove("is-open");
    });
  });
}

const currentYear = document.querySelector("#current-year");
if (currentYear) {
  currentYear.textContent = String(new Date().getFullYear());
}

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (!reduceMotion && "IntersectionObserver" in window) {
  const revealObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -24px 0px" },
  );

  document
    .querySelectorAll(".hero-copy, .hero-art, .section-heading, .service-card, .audience-card, .approach-title, .benefit, .step, .contact-inner > *")
    .forEach((element) => {
      element.classList.add("reveal");
      revealObserver.observe(element);
    });

  document.querySelectorAll(".service-card, .audience-card, .benefit, .step").forEach((element, index) => {
    element.style.setProperty("--reveal-delay", `${index % 3 * 90}ms`);
  });
}

const heroArt = document.querySelector(".hero-art");
if (heroArt && !reduceMotion && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
  heroArt.addEventListener("pointermove", (event) => {
    const bounds = heroArt.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width - 0.5;
    const y = (event.clientY - bounds.top) / bounds.height - 0.5;
    heroArt.style.setProperty("--pointer-x", `${x * 20}px`);
    heroArt.style.setProperty("--pointer-y", `${y * 20}px`);
  });

  heroArt.addEventListener("pointerleave", () => {
    heroArt.style.setProperty("--pointer-x", "0px");
    heroArt.style.setProperty("--pointer-y", "0px");
  });
}
