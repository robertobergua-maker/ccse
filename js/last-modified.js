(function () {
    function formatLastModified(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return null;
        return new Intl.DateTimeFormat('es-ES', {
            dateStyle: 'short',
            timeStyle: 'short'
        }).format(date);
    }

    document.addEventListener('DOMContentLoaded', function () {
        // Solo actuar si existe el elemento destino explícito
        const target = document.getElementById('last-modified-label');
        if (!target) return;

        const formatted = formatLastModified(document.lastModified);
        if (formatted) target.textContent = 'v' + formatted;
    });
}());
