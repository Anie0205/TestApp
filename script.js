const helloBtn = document.getElementById("helloBtn");
const message = document.getElementById("message");
const themeBtn = document.getElementById("themeBtn");

helloBtn.addEventListener("click", () => {
    message.textContent = "Hello! Your JavaScript is working 🎉";
});

themeBtn.addEventListener("click", () => {
    document.body.classList.toggle("dark");

    if (document.body.classList.contains("dark")) {
        themeBtn.textContent = "☀️";
    } else {
        themeBtn.textContent = "🌙";
    }
});