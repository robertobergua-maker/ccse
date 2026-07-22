(function () {
    function formatLastModified(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return 'fecha no disponible';
        }

        return new Intl.DateTimeFormat('es-ES', {
            dateStyle: 'short',
            timeStyle: 'short'
        }).format(date);
    }

    document.addEventListener('DOMContentLoaded', function () {
        const container = document.querySelector('.container') || document.body;
        const existingFooter = container.querySelector('footer');
        const lastModified = document.createElement(existingFooter ? 'p' : 'footer');
        lastModified.className = 'last-modified';
        lastModified.textContent = 'Ultima modificacion: ' + formatLastModified(document.lastModified);
        lastModified.style.color = '#667085';
        lastModified.style.fontSize = '0.85rem';
        lastModified.style.marginTop = '16px';
        lastModified.style.textAlign = 'center';

        (existingFooter || container).appendChild(lastModified);
    });
}());
